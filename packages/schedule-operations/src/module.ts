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
  createSafeSchemaManifestRef,
  structuredOutcomeSchema,
  type SafeSchemaManifestRef,
  type StructuredOutcome,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import {
  SCHEDULE_PLACEMENT_OPERATION_SCHEMA_REFS,
  schedulePlacementAuthorInputSchema,
  schedulePlacementConflictDetailSchema,
  schedulePlacementOperationResultSchema,
  schedulePlacementReadInputSchema,
  schedulePlacementReadResultSchema,
  schedulePlacementResultSchema,
  schedulePlacementSnapshotSchema
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
  parseContractVersion,
  parseEventId,
  parseInstant,
  parseWorkspaceId,
  type Clock,
  type InvocationId,
  type WorkspaceId
} from '@jooevents/kernel';
import type { SchedulePlacementScope, SchedulePlacementState } from '@jooevents/schedule';
import { z } from 'zod';
import {
  createSchedulePlacementDirectHandler,
  schedulePlacementDirectContributionSchema
} from './direct-preparation';

export const SCHEDULE_PLACEMENT_SNAPSHOT_READ_OPERATION = Object.freeze({
  name: 'schedule.placement.snapshot.read', version: 1
});
export const SCHEDULE_PLACEMENT_OPERATION = Object.freeze({ name: 'schedule.placement', version: 1 });
export const SCHEDULE_PLACEMENT_DIRECT_HANDLER_CAPABILITY = ref('capability.schedule.placement-direct');
export const SCHEDULE_PLACEMENT_REQUEST_HASH_PROFILE = ref('request-hash.schedule.placement');
export const SCHEDULE_PLACEMENT_READ_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.schedule.read', version: parseContractVersion(1)
});
export const SCHEDULE_PLACEMENT_MANAGE_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.schedule.manage', version: parseContractVersion(1)
});
export const SCHEDULE_PLACEMENT_READ_PERMISSION_ID: PermissionId = 'schedule.read';
export const SCHEDULE_PLACEMENT_MANAGE_PERMISSION_ID: PermissionId = 'schedule.manage';

const applicationIdSchema = z.uuid();
const nullDetailSchema = z.null();
export const schedulePlacementReadQueryInputSchema = schedulePlacementReadInputSchema;
export const schedulePlacementSnapshotCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: schedulePlacementSnapshotSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
export const schedulePlacementSnapshotReadResultSchema = schedulePlacementReadResultSchema;
const schedulePlacementDirectCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: schedulePlacementResultSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
const schedulePlacementDirectStaleDetailSchema = z.union([
  z.strictObject({
    code: z.enum([
      'wrong_scope', 'stale_schedule', 'occurrence_exists', 'occurrence_missing',
      'stale_occurrence', 'session_missing', 'room_missing', 'room_retired',
      'session_track_required', 'stale_room_query', 'invalid_plan'
    ]),
    action: z.enum(['place', 'move', 'unplace']),
    occurrenceId: applicationIdSchema
  }),
  z.strictObject({
    code: z.enum([
      'wrong_scope', 'stale_schedule', 'stale_vocabulary', 'stale_event',
      'break_exists', 'break_missing', 'stale_break', 'break_not_active',
      'break_not_removed', 'room_missing', 'room_retired', 'day_outside_event',
      'storage_adapter_unavailable', 'invalid_plan'
    ]),
    action: z.enum(['break_add', 'break_remove', 'break_restore']),
    breakIds: z.array(applicationIdSchema).min(1).max(100)
  })
]);

function ref(key: string): VersionedDefinitionRef {
  return Object.freeze({ key, version: 1 });
}
function schemaRef(key: string, schema: z.ZodType): SafeSchemaManifestRef {
  return createSafeSchemaManifestRef(key, schema);
}
function authorityOutcome(reason: CurrentAuthorityDenialReason): StructuredOutcome {
  return Object.freeze({
    class: 'access_denied', kind: `authority.${reason}`, retryable: false,
    subjects: [], detail: null, detailSchemaVersion: 1
  });
}
function eventRequiredOutcome(): StructuredOutcome {
  return Object.freeze({
    class: 'conflict', kind: 'schedule.event_required', retryable: false,
    subjects: [], detail: null, detailSchemaVersion: 1
  });
}

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
  readonly scheduleRead: {
    readSchedule(scope: SchedulePlacementScope): SchedulePlacementState | undefined
      | Promise<SchedulePlacementState | undefined>;
  };
  readonly clock: Clock;
  readonly ids: { newInvocationId(): InvocationId };
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
  readonly requestHashSealer: RequestHashSealer;
  readonly idempotencyCredentialProfile: VersionedKeyProfileRef;
  readonly idempotencyCredentialSealer: IdempotencyCredentialSealer;
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
      const evidenceIds = Object.freeze([...new Set(resolved.evidenceIds.map((value) => {
        if (typeof value !== 'string' || value.trim() !== value || !value || value.length > 512) {
          throw new TypeError('schedule_current_event_evidence_invalid');
        }
        return value;
      }))].sort());
      if (resolved.eventId === undefined) return Object.freeze({
        workspaceId: input.workspaceId,
        subjects: Object.freeze([{ kind: 'workspace' as const, id: input.workspaceId }]),
        resolutionEvidenceIds: evidenceIds
      });
      const eventId = parseEventId(resolved.eventId);
      return Object.freeze({
        workspaceId: input.workspaceId, eventId,
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
    definition: input.definition, operation: input.operation,
    riskFloor: 'low', unattendedRiskCeiling: 'low',
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
}

export function createSchedulePlacementOperationModule(
  input: CreateSchedulePlacementOperationModuleInput
): OperationRegistryModule {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  if (input.policies.read.key !== SCHEDULE_PLACEMENT_READ_ACCESS_POLICY.key
      || input.policies.read.version !== SCHEDULE_PLACEMENT_READ_ACCESS_POLICY.version) {
    throw new TypeError('schedule_placement_read_policy_catalog_mismatch');
  }
  const refs = {
    context: ref('context.schedule.placement-snapshot-read'),
    autonomy: ref('autonomy.schedule.placement-snapshot-read'),
    capability: ref('capability.schedule.placement-snapshot-read'),
    handler: ref('handler.schedule.placement-snapshot-read'),
    projection: ref('projection.schedule.placement-snapshot-read.operator'),
    trace: ref('trace.schedule.placement-snapshot-read'),
    record: ref('record-profile.schedule.read-operational-trace')
  };
  const schemas = {
    input: SCHEDULE_PLACEMENT_OPERATION_SCHEMA_REFS.snapshotRead.inputSchema,
    canonical: schemaRef('schema.schedule.placement-snapshot-read.canonical-result', schedulePlacementSnapshotCanonicalResultSchema),
    projected: SCHEDULE_PLACEMENT_OPERATION_SCHEMA_REFS.snapshotRead.resultSchema,
    null: schemaRef('schema.schedule.read.null-detail', nullDetailSchema)
  };
  const lane = parseOperationAccessLane({
    kind: 'operator', surface: 'operator_http', policy: input.policies.read
  });
  const autonomy = operationAutonomy({
    operation: SCHEDULE_PLACEMENT_SNAPSHOT_READ_OPERATION, definition: refs.autonomy
  });
  const context = createReadInvocationContextBuilder({
    reference: refs.context, operation: SCHEDULE_PLACEMENT_SNAPSHOT_READ_OPERATION,
    effect: 'read', lanes: [lane],
    scopeResolver: currentEventScopeResolver({ workspaceId, source: input.currentEvent }),
    authorityResolver: input.currentAuthority, clock: input.clock,
    newInvocationId: input.ids.newInvocationId,
    authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.scopePartitionProfile,
    requestCanonicalizationProfile: input.requestCanonicalizationProfile,
    deniedAuthorityOutcome: authorityOutcome
  });
  const capability: ReadCapabilityRegistration = Object.freeze({
    reference: refs.capability,
    async openSnapshot(invocation: ReadInvocationContext) {
      if (invocation.scope.eventId === undefined) return Object.freeze({ kind: 'event_required' });
      const state = await input.scheduleRead.readSchedule({
        workspaceId: invocation.scope.workspaceId, eventId: invocation.scope.eventId
      });
      if (!state) throw new TypeError('schedule_current_event_state_missing');
      if (state.scope.workspaceId !== invocation.scope.workspaceId
          || state.scope.eventId !== invocation.scope.eventId) {
        throw new TypeError('schedule_current_event_state_scope_mismatch');
      }
      return Object.freeze({ kind: 'schedule', state });
    }
  });
  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => ({
    class: 'access_denied' as const, kind: `authority.${reason}`,
    retryable: false, detailSchema: schemas.null
  }));
  return Object.freeze({
    id: 'schedule-placement-read.operation', source: Object.freeze({
      effectExecutionFamilies: [], effectPhases: [], terminalizationResolvers: [],
      riskResolvers: [], autonomyEvidenceResolvers: [], renewedApprovalResolvers: [],
      autonomyPreflights: [], autonomyPolicies: [autonomy],
      schemas: [
        { reference: schemas.input, schema: schedulePlacementReadInputSchema },
        { reference: schemas.canonical, schema: schedulePlacementSnapshotCanonicalResultSchema },
        { reference: schemas.projected, schema: schedulePlacementReadResultSchema },
        { reference: schemas.null, schema: nullDetailSchema }
      ],
      contextBuilders: [context], readCapabilities: [capability],
      handlers: [{
        reference: refs.handler, readCapability: refs.capability,
        canonicalResultSchema: schemas.canonical,
        handle: ({ businessInput, snapshot }: {
          readonly businessInput: unknown;
          readonly snapshot: Readonly<Record<string, unknown>>;
        }) => {
          if (snapshot.kind === 'event_required') {
            return { kind: 'outcome' as const, outcome: eventRequiredOutcome() };
          }
          const query = schedulePlacementReadInputSchema.parse(businessInput);
          const state = snapshot.state as SchedulePlacementState | undefined;
          if (!state) throw new TypeError('schedule_current_event_state_missing');
          return {
            kind: 'success' as const,
            data: schedulePlacementSnapshotSchema.parse({
              schemaVersion: 1, scope: state.scope, scheduleVersion: state.scheduleVersion,
              occurrences: state.occurrences
                .filter((occurrence) => occurrence.startAt < query.endAt && query.startAt < occurrence.endAt)
                .slice(0, query.limit),
              breaks: state.breaks.slice(0, query.limit)
            })
          };
        }
      }],
      projections: [{ reference: refs.projection, canonicalResultSchema: schemas.canonical,
        projectedResultSchema: schemas.projected,
        project: (candidate: unknown) => schedulePlacementSnapshotCanonicalResultSchema.parse(candidate) }],
      readOperationalTraceTargets: [{ reference: refs.trace,
        kind: 'read_operational_trace_record' as const, recordProfile: refs.record }],
      operationAuditTargets: [],
      operationAuditRecordProfiles: [{ reference: refs.record, kind: 'canonical_json' as const, maximumBytes: 65_536 }],
      operations: [{
        ...SCHEDULE_PLACEMENT_SNAPSHOT_READ_OPERATION,
        lifecycle: { status: 'active' as const },
        summary: 'Read placement occurrences for the current Event and UTC range.',
        effect: 'read' as const, maxRisk: 'low' as const,
        autonomyPolicy: refs.autonomy, consequenceTags: [],
        inputSchema: schemas.input, canonicalResultSchema: schemas.canonical,
        outcomes: [...accessOutcomes, { class: 'conflict' as const,
          kind: 'schedule.event_required', retryable: false, detailSchema: schemas.null }],
        accessLanes: [lane], contextBuilder: refs.context,
        readCapability: refs.capability, handler: refs.handler,
        observability: { trace: { mode: 'required' as const, target: refs.trace },
          immutableAudit: { mode: 'none' as const } },
        bindings: [{ surface: 'operator_http' as const, method: 'GET' as const,
          path: '/api/events/current/schedule/placements', input: 'query' as const,
          browserResumption: { kind: 'none' as const }, projection: refs.projection }]
      }],
      effectContextBuilders: [], effectHandlers: [], effectOperations: []
    })
  });
}

export function createSchedulePlacementDirectOperationModule(
  input: CreateSchedulePlacementOperationModuleInput
): OperationRegistryModule {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  if (input.policies.manage.key !== SCHEDULE_PLACEMENT_MANAGE_ACCESS_POLICY.key
      || input.policies.manage.version !== SCHEDULE_PLACEMENT_MANAGE_ACCESS_POLICY.version) {
    throw new TypeError('schedule_placement_direct_policy_catalog_mismatch');
  }
  const refs = {
    context: ref('context.schedule.placement'), autonomy: ref('autonomy.schedule.placement'),
    handler: ref('handler.schedule.placement'), projection: ref('projection.schedule.placement.operator'),
    audit: ref('audit.schedule.placement'), record: ref('record-profile.schedule.placement-operation-log'),
    keySource: ref('idempotency.operator-header'), concurrency: ref('concurrency.schedule.placement'),
    family: ref('schedule.placement.execution-family'), phase: ref('schedule.placement.phase.direct-uow'),
    terminalization: ref('schedule.placement.terminalization'), risk: ref('schedule.placement.risk'),
    evidence: ref('schedule.placement.autonomy-evidence'), approval: ref('schedule.placement.approval'),
    preflight: ref('schedule.placement.autonomy-preflight')
  };
  const schemas = {
    input: SCHEDULE_PLACEMENT_OPERATION_SCHEMA_REFS.placement.inputSchema,
    contribution: schemaRef('schema.schedule.placement.contribution', schedulePlacementDirectContributionSchema),
    canonical: schemaRef('schema.schedule.placement.canonical-result', schedulePlacementDirectCanonicalResultSchema),
    projected: SCHEDULE_PLACEMENT_OPERATION_SCHEMA_REFS.placement.resultSchema,
    null: schemaRef('schema.schedule.placement.null-detail', nullDetailSchema),
    stale: schemaRef('schema.schedule.placement-direct-stale.detail', schedulePlacementDirectStaleDetailSchema),
    overlap: schemaRef('schema.schedule.placement-direct-overlap.detail', schedulePlacementConflictDetailSchema)
  };
  const lane = parseOperationAccessLane({ kind: 'operator', surface: 'operator_http', policy: input.policies.manage });
  const autonomy = operationAutonomy({ operation: SCHEDULE_PLACEMENT_OPERATION, definition: refs.autonomy });
  const context = createEffectInvocationContextBuilder({
    reference: refs.context, operation: SCHEDULE_PLACEMENT_OPERATION, effect: 'commit', lanes: [lane],
    scopeResolver: currentEventScopeResolver({ workspaceId, source: input.currentEvent }),
    authorityResolver: input.currentAuthority, clock: input.clock, newInvocationId: input.ids.newInvocationId,
    authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.scopePartitionProfile,
    requestCanonicalizationProfile: input.requestCanonicalizationProfile,
    requestHashProfile: SCHEDULE_PLACEMENT_REQUEST_HASH_PROFILE, requestHashSealer: input.requestHashSealer,
    idempotencyCredentialProfile: input.idempotencyCredentialProfile,
    idempotencyCredentialSealer: input.idempotencyCredentialSealer,
    deniedAuthorityOutcome: authorityOutcome
  });
  const family = createSingleUnitOfWorkFamilyRegistration({ reference: refs.family, phase: refs.phase });
  const terminalization = createTerminalizationResolverRegistration({
    reference: refs.terminalization, operation: SCHEDULE_PLACEMENT_OPERATION, phase: refs.phase,
    resolve: ({ result }) => result.kind === 'success'
      ? { kind: 'terminal' as const } : { kind: 'nonterminal' as const }
  });
  const phase = createSingleUnitOfWorkPhaseRegistration({
    reference: refs.phase, family: refs.family, operation: SCHEDULE_PLACEMENT_OPERATION,
    effect: 'commit', handler: refs.handler, handlerCapability: SCHEDULE_PLACEMENT_DIRECT_HANDLER_CAPABILITY,
    contributionSchema: schemas.contribution, terminalization: refs.terminalization,
    terminalOutcomeKeys: [], contentionOutcome: { class: 'conflict', kind: 'operation.in_progress',
      retryable: true, subjects: [], detail: null, detailSchemaVersion: 1 }
  });
  const risk = createOperationRiskResolverRegistration({
    reference: refs.risk, operation: SCHEDULE_PLACEMENT_OPERATION,
    resolve: () => ({ risk: 'low', consequenceTags: ['schedule-placement-changed'], evidenceIds: ['schedule.placement.risk'] })
  });
  const evidence = createAutonomyEvidenceResolverRegistration({
    reference: refs.evidence, operation: SCHEDULE_PLACEMENT_OPERATION,
    resolve: ({ subject }) => {
      const bounds = Object.freeze({ scopeKeys: Object.freeze([...subject.scopeKeys]), maximumSpendMicros: 0,
        maximumActions: 1, notAfter: parseInstant(new Date(Date.parse(subject.evaluatedAt) + 60_000).toISOString()) });
      return Object.freeze({
        evaluatedAt: subject.evaluatedAt, hardBounds: bounds, unattendedBounds: bounds,
        spendMicros: 0, actionCount: 1, completesBy: subject.evaluatedAt,
        proposedAction: { key: 'schedule.placement.execute', version: 1, digestSha256: subject.requestHashSha256 },
        failure: { kind: 'none' as const }
      });
    }
  });
  const approval = createRenewedApprovalResolverRegistration({
    reference: refs.approval, operation: SCHEDULE_PLACEMENT_OPERATION,
    resolve: () => ({ approverCurrentlyAuthorized: false })
  });
  const preflight = createAutonomyPreflightRegistration({
    reference: refs.preflight, operation: SCHEDULE_PLACEMENT_OPERATION, policy: refs.autonomy,
    riskResolver: refs.risk, evidenceResolver: refs.evidence,
    approvalResolver: refs.approval, interventionOutcomes: autonomyInterventionOutcomes(1)
  });
  const handler = createSchedulePlacementDirectHandler({
    reference: refs.handler, handlerCapability: SCHEDULE_PLACEMENT_DIRECT_HANDLER_CAPABILITY,
    contributionSchema: schemas.contribution, canonicalResultSchema: schemas.canonical
  });
  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => ({
    class: 'access_denied' as const, kind: `authority.${reason}`, retryable: false, detailSchema: schemas.null
  }));
  return Object.freeze({
    id: 'schedule-placement.operation', source: Object.freeze({
      effectExecutionFamilies: [family], effectPhases: [phase], terminalizationResolvers: [terminalization],
      riskResolvers: [risk], autonomyEvidenceResolvers: [evidence], renewedApprovalResolvers: [approval],
      autonomyPreflights: [preflight], autonomyPolicies: [autonomy], contextBuilders: [], readCapabilities: [],
      handlers: [], operations: [], readOperationalTraceTargets: [],
      schemas: [
        { reference: schemas.input, schema: schedulePlacementAuthorInputSchema },
        { reference: schemas.contribution, schema: schedulePlacementDirectContributionSchema },
        { reference: schemas.canonical, schema: schedulePlacementDirectCanonicalResultSchema },
        { reference: schemas.projected, schema: schedulePlacementOperationResultSchema },
        { reference: schemas.null, schema: nullDetailSchema },
        { reference: schemas.stale, schema: schedulePlacementDirectStaleDetailSchema },
        { reference: schemas.overlap, schema: schedulePlacementConflictDetailSchema }
      ],
      projections: [{ reference: refs.projection, canonicalResultSchema: schemas.canonical,
        projectedResultSchema: schemas.projected,
        project: (candidate: unknown) => schedulePlacementDirectCanonicalResultSchema.parse(candidate) }],
      operationAuditTargets: [{ reference: refs.audit, kind: 'operation_audit_record' as const, recordProfile: refs.record }],
      operationAuditRecordProfiles: [{ reference: refs.record, kind: 'canonical_json' as const, maximumBytes: 262_144 }],
      effectContextBuilders: [context], effectHandlers: [handler], effectOperations: [{
        ...SCHEDULE_PLACEMENT_OPERATION, lifecycle: { status: 'active' as const },
        summary: 'Place or remove a Session, or add, remove, or restore Schedule breaks.', effect: 'commit' as const,
        maxRisk: 'low' as const, autonomyPolicy: refs.autonomy,
        consequenceTags: ['schedule-placement-changed'], inputSchema: schemas.input,
        agentAction: { eligible: true as const, displayLabel: 'Change a schedule placement', consequences: ['A session may be placed, moved, or removed from the schedule.'], externalEffect: 'none' as const },
        contributionSchema: schemas.contribution, canonicalResultSchema: schemas.canonical,
        outcomes: [
          { class: 'idempotency_conflict' as const, kind: 'operation.request_changed', retryable: false, detailSchema: schemas.null },
          ...accessOutcomes,
          { class: 'conflict' as const, kind: 'schedule.event_required', retryable: false, detailSchema: schemas.null },
          { class: 'conflict' as const, kind: 'schedule_room_overlap', retryable: false, detailSchema: schemas.overlap },
          { class: 'stale_revision' as const, kind: 'schedule_placement_changed', retryable: false, detailSchema: schemas.stale },
          { class: 'stale_revision' as const, kind: 'schedule_break_changed', retryable: false, detailSchema: schemas.stale },
          { class: 'conflict' as const, kind: 'schedule_break_unavailable', retryable: false, detailSchema: schemas.stale },
          { class: 'conflict' as const, kind: 'operation.in_progress', retryable: true, detailSchema: schemas.null },
          ...autonomyInterventionOutcomeDeclarations(schemas.null)
        ],
        accessLanes: [lane], contextBuilder: refs.context,
        handlerCapability: SCHEDULE_PLACEMENT_DIRECT_HANDLER_CAPABILITY, handler: refs.handler,
        audit: { mode: 'required' as const, target: refs.audit },
        idempotency: { keySource: refs.keySource, credentialVerifierProfile: input.idempotencyCredentialProfile,
          requestHashProfile: SCHEDULE_PLACEMENT_REQUEST_HASH_PROFILE },
        concurrency: refs.concurrency,
        execution: { kind: 'single_unit_of_work' as const, profile: 'direct_audited' as const,
          family: refs.family, phase: refs.phase, terminalization: refs.terminalization,
          autonomyPreflight: refs.preflight,
          history: { summariesByAction: Object.freeze({
            place: 'Placed a session on the schedule',
            move: 'Moved a session on the schedule',
            unplace: 'Removed a session from the schedule',
            break_add: 'Added a break to the schedule',
            break_remove: 'Removed a break from the schedule',
            break_restore: 'Restored a break to the schedule'
          }) } },
        bindings: [{ surface: 'operator_http' as const, method: 'POST' as const,
          path: '/api/events/current/schedule/placements', input: 'body' as const,
          browserResumption: { kind: 'none' as const }, projection: refs.projection }]
      }]
    })
  });
}
