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
  type EffectHandlerRegistration,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type IdempotencyCredentialSealer,
  type InvocationEvidence,
  type OperationRegistryModule,
  type ReadCapabilityRegistration,
  type RequestHashSealer
} from '@jooevents/application';
import {
  CALENDAR_NOTICE_OPERATION_SCHEMA_REFS,
  calendarNoticeGenerationControlCanonicalResultSchema,
  calendarNoticeGenerationControlDataSchema,
  calendarNoticeGenerationControlInputSchema,
  calendarNoticeGenerationControlOperationResultSchema,
  calendarNoticeGenerationListCanonicalResultSchema,
  calendarNoticeGenerationListDataSchema,
  calendarNoticeGenerationListInputSchema,
  calendarNoticeGenerationListOperationResultSchema,
  calendarNoticeGenerationSchema,
  type CalendarNoticeGenerationDto,
  type CalendarScope
} from '@jooevents/contracts/calendar';
import {
  createSafeSchemaManifestRef,
  structuredOutcomeSchema,
  type SafeSchemaManifestRef,
  type StructuredOutcome,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import type { DeadlineCurrentEventSource } from '@jooevents/deadline-operations';
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

export const CALENDAR_NOTICE_GENERATION_LIST_OPERATION = Object.freeze({
  name: 'calendar.notice-generations.list', version: 1
});
export const CALENDAR_NOTICE_GENERATION_CONTROL_OPERATION = Object.freeze({
  name: 'calendar.notice-generations.control', version: 1
});
export const CALENDAR_NOTICE_READ_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.calendar-notice.read', version: parseContractVersion(1)
});
export const CALENDAR_NOTICE_MANAGE_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.calendar-notice.manage', version: parseContractVersion(1)
});
export const CALENDAR_NOTICE_READ_PERMISSION_ID: PermissionId = 'event.read';
export const CALENDAR_NOTICE_MANAGE_PERMISSION_ID: PermissionId = 'event.manage';

function ref(key: string): VersionedDefinitionRef {
  return Object.freeze({ key, version: 1 });
}
function schemaRef(key: string, schema: z.ZodType): SafeSchemaManifestRef {
  return createSafeSchemaManifestRef(key, schema);
}

export const CALENDAR_NOTICE_CONTROL_REQUEST_HASH_PROFILE = ref(
  'request-hash.calendar.notice-generation.control'
);
export const CALENDAR_NOTICE_CONTROL_HANDLER_CAPABILITY = ref(
  'capability.calendar.notice-generation.control-direct'
);
export const CALENDAR_NOTICE_OPERATION_KEY_PROFILES = Object.freeze({
  authorityPrincipal: Object.freeze({
    key: 'key-profile.calendar-notice.operator-principal', version: parseContractVersion(1)
  }),
  scopePartition: Object.freeze({
    key: 'key-profile.calendar-notice.current-event-scope', version: parseContractVersion(1)
  }),
  requestCanonicalization: Object.freeze({
    key: 'key-profile.calendar-notice.request-canonicalization', version: parseContractVersion(1)
  }),
  idempotencyCredential: Object.freeze({
    key: 'key-profile.calendar-notice.idempotency-credential', version: parseContractVersion(1)
  })
});

const nullDetailSchema = z.null();
export const calendarNoticeControlDomainContributionSchema = z.strictObject({
  kind: z.literal('calendar_notice_generation_control'),
  input: calendarNoticeGenerationControlInputSchema,
  scope: z.strictObject({ workspaceId: z.uuid(), eventId: z.uuid() }),
  occurredAt: z.string()
});
export const calendarNoticeControlContributionSchema = z.union([
  z.strictObject({
    result: z.strictObject({
      kind: z.literal('success'), data: calendarNoticeGenerationControlDataSchema
    }),
    domain: calendarNoticeControlDomainContributionSchema,
    effectContributions: z.tuple([])
  }),
  z.strictObject({
    result: z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema }),
    domain: z.null(),
    effectContributions: z.tuple([])
  })
]);
export type CalendarNoticeControlContribution = z.infer<typeof calendarNoticeControlContributionSchema>;

export const CALENDAR_NOTICE_OPERATION_RUNTIME_SCHEMA_REFS = Object.freeze({
  listInput: CALENDAR_NOTICE_OPERATION_SCHEMA_REFS.list.inputSchema,
  listCanonical: schemaRef('schema.calendar.notice-generation.list.canonical-result',
    calendarNoticeGenerationListCanonicalResultSchema),
  listProjected: CALENDAR_NOTICE_OPERATION_SCHEMA_REFS.list.resultSchema,
  controlInput: CALENDAR_NOTICE_OPERATION_SCHEMA_REFS.control.inputSchema,
  controlContribution: schemaRef('schema.calendar.notice-generation.control.contribution',
    calendarNoticeControlContributionSchema),
  controlCanonical: schemaRef('schema.calendar.notice-generation.control.canonical-result',
    calendarNoticeGenerationControlCanonicalResultSchema),
  controlProjected: CALENDAR_NOTICE_OPERATION_SCHEMA_REFS.control.resultSchema,
  nullDetail: schemaRef('schema.calendar.notice-generation.operation.null-detail', nullDetailSchema)
});

const refs = Object.freeze({
  listContext: ref('context.calendar.notice-generation.list'),
  listAutonomy: ref('autonomy.calendar.notice-generation.list'),
  listCapability: ref('capability.calendar.notice-generation.list'),
  listHandler: ref('handler.calendar.notice-generation.list'),
  listProjection: ref('projection.calendar.notice-generation.list.operator'),
  listTrace: ref('trace.calendar.notice-generation.list'),
  controlContext: ref('context.calendar.notice-generation.control'),
  controlAutonomy: ref('autonomy.calendar.notice-generation.control'),
  controlConcurrency: ref('concurrency.calendar.notice-generation.control'),
  controlFamily: ref('calendar.notice-generation.control.execution-family'),
  controlPhase: ref('calendar.notice-generation.control.phase.direct-uow'),
  controlTerminalization: ref('calendar.notice-generation.control.terminalization'),
  controlRisk: ref('calendar.notice-generation.control.risk'),
  controlEvidence: ref('calendar.notice-generation.control.autonomy-evidence'),
  controlApproval: ref('calendar.notice-generation.control.approval'),
  controlPreflight: ref('calendar.notice-generation.control.preflight'),
  controlHandler: ref('handler.calendar.notice-generation.control'),
  controlProjection: ref('projection.calendar.notice-generation.control.operator'),
  audit: ref('audit.calendar.notice-generation.control'),
  auditRecordProfile: ref('record-profile.calendar.notice-generation.operation-audit'),
  keySource: ref('idempotency.operator-header')
});

export interface CalendarNoticeGenerationReadSource {
  listNoticeGenerations(scope: CalendarScope): readonly CalendarNoticeGenerationDto[];
}

interface SealedPreparation {
  readonly capability: VersionedDefinitionRef;
  readonly context: EffectInvocationContext;
  readonly prepare: (businessInput: unknown) => CalendarNoticeControlContribution;
  spent: boolean;
}
const preparations = new WeakMap<object, SealedPreparation>();

function sameRef(left: VersionedDefinitionRef, right: VersionedDefinitionRef): boolean {
  return left.key === right.key && left.version === right.version;
}

export function sealCalendarNoticeControlPreparation(input: {
  readonly capability: VersionedDefinitionRef;
  readonly context: EffectInvocationContext;
  readonly prepare: (businessInput: unknown) => CalendarNoticeControlContribution;
}): EffectHandlerSnapshot {
  const snapshot = Object.freeze({ strategy: 'calendar_notice_generation_control', version: 1 });
  preparations.set(snapshot, { ...input, spent: false });
  return snapshot;
}

function createControlHandler(): EffectHandlerRegistration {
  return Object.freeze({
    reference: refs.controlHandler,
    effect: 'commit' as const,
    handlerCapability: CALENDAR_NOTICE_CONTROL_HANDLER_CAPABILITY,
    contributionSchema: CALENDAR_NOTICE_OPERATION_RUNTIME_SCHEMA_REFS.controlContribution,
    canonicalResultSchema: CALENDAR_NOTICE_OPERATION_RUNTIME_SCHEMA_REFS.controlCanonical,
    handle({ businessInput, context, snapshot }:
      Parameters<EffectHandlerRegistration['handle']>[0]) {
      const sealed = preparations.get(snapshot);
      if (!sealed || sealed.spent || sealed.context !== context
          || !sameRef(sealed.capability, CALENDAR_NOTICE_CONTROL_HANDLER_CAPABILITY)) {
        throw new TypeError('invalid_calendar_notice_control_preparation');
      }
      sealed.spent = true;
      const contribution = sealed.prepare(businessInput);
      return {
        result: contribution.result,
        domain: contribution.domain,
        effectContributions: [...contribution.effectContributions]
      };
    }
  });
}

function authorityOutcome(reason: CurrentAuthorityDenialReason): StructuredOutcome {
  return Object.freeze({
    class: 'access_denied', kind: `authority.${reason}`, retryable: false,
    subjects: [], detail: null, detailSchemaVersion: 1
  });
}
function eventRequiredOutcome(): StructuredOutcome {
  return Object.freeze({
    class: 'conflict', kind: 'calendar.event_required', retryable: false,
    subjects: [], detail: null, detailSchemaVersion: 1
  });
}
function autonomy(
  operation: { name: string; version: number },
  definition: VersionedDefinitionRef,
  risk: 'low' | 'normal'
) {
  return createOperationAutonomyPolicy({
    definition, operation, riskFloor: risk, unattendedRiskCeiling: risk,
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

export function createCalendarNoticeGenerationOperationModule(input: {
  readonly workspaceId: WorkspaceId;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly currentEvent: DeadlineCurrentEventSource;
  readonly read: CalendarNoticeGenerationReadSource;
  readonly clock: Clock;
  readonly ids: { newInvocationId(): InvocationId };
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
  readonly requestHashSealer: RequestHashSealer;
  readonly idempotencyCredentialProfile: VersionedKeyProfileRef;
  readonly idempotencyCredentialSealer: IdempotencyCredentialSealer;
}): OperationRegistryModule {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  const scopeResolver = Object.freeze({
    async resolve() {
      const current = await input.currentEvent.resolveCurrentEvent(workspaceId);
      const eventId = current.eventId === undefined ? undefined : parseEventId(current.eventId);
      return Object.freeze({
        workspaceId,
        ...(eventId === undefined ? {} : { eventId }),
        subjects: Object.freeze(eventId === undefined
          ? [{ kind: 'workspace' as const, id: workspaceId }]
          : [{ kind: 'workspace' as const, id: workspaceId }, { kind: 'event' as const, id: eventId }]),
        resolutionEvidenceIds: Object.freeze([...new Set(current.evidenceIds)].sort())
      });
    }
  });
  const readLane = parseOperationAccessLane({
    kind: 'operator', surface: 'operator_http', policy: CALENDAR_NOTICE_READ_ACCESS_POLICY
  });
  const manageLane = parseOperationAccessLane({
    kind: 'operator', surface: 'operator_http', policy: CALENDAR_NOTICE_MANAGE_ACCESS_POLICY
  });
  const listAutonomy = autonomy(CALENDAR_NOTICE_GENERATION_LIST_OPERATION, refs.listAutonomy, 'low');
  const controlAutonomy = autonomy(
    CALENDAR_NOTICE_GENERATION_CONTROL_OPERATION, refs.controlAutonomy, 'normal'
  );
  const listContext = createReadInvocationContextBuilder({
    reference: refs.listContext, operation: CALENDAR_NOTICE_GENERATION_LIST_OPERATION,
    effect: 'read', lanes: [readLane], scopeResolver,
    authorityResolver: input.currentAuthority, clock: input.clock,
    newInvocationId: input.ids.newInvocationId,
    authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.scopePartitionProfile,
    requestCanonicalizationProfile: input.requestCanonicalizationProfile,
    deniedAuthorityOutcome: authorityOutcome
  });
  const listCapability: ReadCapabilityRegistration = Object.freeze({
    reference: refs.listCapability,
    openSnapshot: (context: Parameters<ReadCapabilityRegistration['openSnapshot']>[0]) =>
      context.scope.eventId === undefined
      ? Object.freeze({ kind: 'event_required' })
      : Object.freeze({
          kind: 'generations',
          rows: input.read.listNoticeGenerations({
            workspaceId: context.scope.workspaceId,
            eventId: context.scope.eventId
          })
        })
  });
  const controlContext = createEffectInvocationContextBuilder({
    reference: refs.controlContext, operation: CALENDAR_NOTICE_GENERATION_CONTROL_OPERATION,
    effect: 'commit', lanes: [manageLane], scopeResolver,
    authorityResolver: input.currentAuthority, clock: input.clock,
    newInvocationId: input.ids.newInvocationId,
    authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.scopePartitionProfile,
    requestCanonicalizationProfile: input.requestCanonicalizationProfile,
    requestHashProfile: CALENDAR_NOTICE_CONTROL_REQUEST_HASH_PROFILE,
    requestHashSealer: input.requestHashSealer,
    idempotencyCredentialProfile: input.idempotencyCredentialProfile,
    idempotencyCredentialSealer: input.idempotencyCredentialSealer,
    deniedAuthorityOutcome: authorityOutcome
  });
  const family = createSingleUnitOfWorkFamilyRegistration({
    reference: refs.controlFamily, phase: refs.controlPhase
  });
  const terminalization = createTerminalizationResolverRegistration({
    reference: refs.controlTerminalization,
    operation: CALENDAR_NOTICE_GENERATION_CONTROL_OPERATION,
    phase: refs.controlPhase,
    resolve: ({ result }) => result.kind === 'success'
      ? Object.freeze({ kind: 'terminal' as const })
      : Object.freeze({ kind: 'nonterminal' as const })
  });
  const phase = createSingleUnitOfWorkPhaseRegistration({
    reference: refs.controlPhase, family: refs.controlFamily,
    operation: CALENDAR_NOTICE_GENERATION_CONTROL_OPERATION, effect: 'commit',
    handler: refs.controlHandler, handlerCapability: CALENDAR_NOTICE_CONTROL_HANDLER_CAPABILITY,
    contributionSchema: CALENDAR_NOTICE_OPERATION_RUNTIME_SCHEMA_REFS.controlContribution,
    terminalization: refs.controlTerminalization, terminalOutcomeKeys: [],
    contentionOutcome: Object.freeze({
      class: 'conflict' as const, kind: 'operation.in_progress', retryable: true,
      subjects: [], detail: null, detailSchemaVersion: 1
    })
  });
  const risk = createOperationRiskResolverRegistration({
    reference: refs.controlRisk, operation: CALENDAR_NOTICE_GENERATION_CONTROL_OPERATION,
    resolve: () => Object.freeze({
      risk: 'normal' as const,
      consequenceTags: Object.freeze([
        'calendar-notice-hold-changed', 'calendar-notice-released'
      ]),
      evidenceIds: Object.freeze(['calendar.notice-generation.control.risk'])
    })
  });
  const evidence = createAutonomyEvidenceResolverRegistration({
    reference: refs.controlEvidence, operation: CALENDAR_NOTICE_GENERATION_CONTROL_OPERATION,
    resolve: ({ subject }) => {
      const notAfter = parseInstant(new Date(Date.parse(subject.evaluatedAt) + 60_000).toISOString());
      const bounds = Object.freeze({
        scopeKeys: Object.freeze([...subject.scopeKeys]), maximumSpendMicros: 0,
        maximumActions: 1, notAfter
      });
      return Object.freeze({
        evaluatedAt: subject.evaluatedAt, hardBounds: bounds, unattendedBounds: bounds,
        spendMicros: 0, actionCount: 1, completesBy: subject.evaluatedAt,
        proposedAction: Object.freeze({
          key: 'calendar.notice-generation.control.execute', version: 1,
          digestSha256: subject.requestHashSha256
        }),
        failure: Object.freeze({ kind: 'none' as const })
      });
    }
  });
  const approval = createRenewedApprovalResolverRegistration({
    reference: refs.controlApproval, operation: CALENDAR_NOTICE_GENERATION_CONTROL_OPERATION,
    resolve: () => Object.freeze({ approverCurrentlyAuthorized: false })
  });
  const preflight = createAutonomyPreflightRegistration({
    reference: refs.controlPreflight, operation: CALENDAR_NOTICE_GENERATION_CONTROL_OPERATION,
    policy: refs.controlAutonomy, riskResolver: refs.controlRisk,
    evidenceResolver: refs.controlEvidence, approvalResolver: refs.controlApproval,
    interventionOutcomes: autonomyInterventionOutcomes(1)
  });
  const schemas = CALENDAR_NOTICE_OPERATION_RUNTIME_SCHEMA_REFS;
  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => Object.freeze({
    class: 'access_denied' as const, kind: `authority.${reason}`, retryable: false,
    detailSchema: schemas.nullDetail
  }));
  return Object.freeze({ id: 'calendar.notice-generation.operations', source: Object.freeze({
    effectExecutionFamilies: Object.freeze([family]),
    effectPhases: Object.freeze([phase]),
    terminalizationResolvers: Object.freeze([terminalization]),
    riskResolvers: Object.freeze([risk]),
    autonomyEvidenceResolvers: Object.freeze([evidence]),
    renewedApprovalResolvers: Object.freeze([approval]),
    autonomyPreflights: Object.freeze([preflight]),
    autonomyPolicies: Object.freeze([listAutonomy, controlAutonomy]),
    schemas: Object.freeze([
      { reference: schemas.listInput, schema: calendarNoticeGenerationListInputSchema },
      { reference: schemas.listCanonical, schema: calendarNoticeGenerationListCanonicalResultSchema },
      { reference: schemas.listProjected, schema: calendarNoticeGenerationListOperationResultSchema },
      { reference: schemas.controlInput, schema: calendarNoticeGenerationControlInputSchema },
      { reference: schemas.controlContribution, schema: calendarNoticeControlContributionSchema },
      { reference: schemas.controlCanonical, schema: calendarNoticeGenerationControlCanonicalResultSchema },
      { reference: schemas.controlProjected, schema: calendarNoticeGenerationControlOperationResultSchema },
      { reference: schemas.nullDetail, schema: nullDetailSchema }
    ]),
    contextBuilders: Object.freeze([listContext]),
    readCapabilities: Object.freeze([listCapability]),
    handlers: Object.freeze([{
      reference: refs.listHandler, readCapability: refs.listCapability,
      canonicalResultSchema: schemas.listCanonical,
      handle: ({ snapshot }: { snapshot: Readonly<Record<string, unknown>> }) =>
        snapshot.kind === 'event_required'
          ? Object.freeze({ kind: 'outcome' as const, outcome: eventRequiredOutcome() })
          : Object.freeze({ kind: 'success' as const, data: calendarNoticeGenerationListDataSchema.parse({
              schemaVersion: 1, rows: snapshot.rows
            }) })
    }]),
    projections: Object.freeze([{
      reference: refs.listProjection, canonicalResultSchema: schemas.listCanonical,
      projectedResultSchema: schemas.listProjected,
      project: (candidate: unknown) => calendarNoticeGenerationListCanonicalResultSchema.parse(candidate)
    }, {
      reference: refs.controlProjection, canonicalResultSchema: schemas.controlCanonical,
      projectedResultSchema: schemas.controlProjected,
      project: (candidate: unknown) => calendarNoticeGenerationControlCanonicalResultSchema.parse(candidate)
    }]),
    readOperationalTraceTargets: Object.freeze([{
      reference: refs.listTrace, kind: 'read_operational_trace_record' as const,
      recordProfile: refs.auditRecordProfile
    }]),
    operationAuditTargets: Object.freeze([{
      reference: refs.audit, kind: 'operation_audit_record' as const,
      recordProfile: refs.auditRecordProfile
    }]),
    operationAuditRecordProfiles: Object.freeze([{
      reference: refs.auditRecordProfile, kind: 'canonical_json' as const, maximumBytes: 65_536
    }]),
    operations: Object.freeze([{
      ...CALENDAR_NOTICE_GENERATION_LIST_OPERATION,
      lifecycle: { status: 'active' as const },
      summary: 'List pending calendar-notice generations for the current Event.',
      effect: 'read' as const, maxRisk: 'low' as const,
      autonomyPolicy: refs.listAutonomy, consequenceTags: [],
      inputSchema: schemas.listInput, canonicalResultSchema: schemas.listCanonical,
      outcomes: [...accessOutcomes, {
        class: 'conflict' as const, kind: 'calendar.event_required', retryable: false,
        detailSchema: schemas.nullDetail
      }],
      accessLanes: [readLane], contextBuilder: refs.listContext,
      readCapability: refs.listCapability, handler: refs.listHandler,
      observability: {
        trace: { mode: 'required' as const, target: refs.listTrace },
        immutableAudit: { mode: 'none' as const }
      },
      bindings: [{
        surface: 'operator_http' as const, method: 'GET' as const,
        path: '/api/events/current/calendar/notices', input: 'query' as const,
        browserResumption: { kind: 'none' as const }, projection: refs.listProjection
      }]
    }]),
    effectContextBuilders: Object.freeze([controlContext]),
    effectHandlers: Object.freeze([createControlHandler()]),
    effectOperations: Object.freeze([{
      ...CALENDAR_NOTICE_GENERATION_CONTROL_OPERATION,
      lifecycle: { status: 'active' as const },
      summary: 'Hold or release one pending calendar-notice generation.',
      effect: 'commit' as const, maxRisk: 'normal' as const,
      autonomyPolicy: refs.controlAutonomy,
      consequenceTags: ['calendar-notice-hold-changed', 'calendar-notice-released'],
      inputSchema: schemas.controlInput, contributionSchema: schemas.controlContribution,
      canonicalResultSchema: schemas.controlCanonical,
      outcomes: [{
        class: 'idempotency_conflict' as const, kind: 'operation.request_changed',
        retryable: false, detailSchema: schemas.nullDetail
      }, ...accessOutcomes, {
        class: 'conflict' as const, kind: 'calendar.event_required', retryable: false,
        detailSchema: schemas.nullDetail
      }, {
        class: 'stale_revision' as const, kind: 'calendar.notice_generation_changed',
        retryable: false, detailSchema: schemas.nullDetail
      }, {
        class: 'conflict' as const, kind: 'operation.in_progress', retryable: true,
        detailSchema: schemas.nullDetail
      }, ...autonomyInterventionOutcomeDeclarations(schemas.nullDetail)],
      accessLanes: [manageLane], contextBuilder: refs.controlContext,
      handlerCapability: CALENDAR_NOTICE_CONTROL_HANDLER_CAPABILITY,
      handler: refs.controlHandler, audit: { mode: 'required' as const, target: refs.audit },
      idempotency: {
        keySource: refs.keySource,
        credentialVerifierProfile: input.idempotencyCredentialProfile,
        requestHashProfile: CALENDAR_NOTICE_CONTROL_REQUEST_HASH_PROFILE
      },
      concurrency: refs.controlConcurrency,
      execution: {
        kind: 'single_unit_of_work' as const, profile: 'direct_audited' as const,
        family: refs.controlFamily, phase: refs.controlPhase,
        terminalization: refs.controlTerminalization, autonomyPreflight: refs.controlPreflight,
        history: { summariesByAction: Object.freeze({
          set_hold: 'Changed a calendar notice hold',
          release_now: 'Released calendar updates'
        }) }
      },
      bindings: [{
        surface: 'operator_http' as const, method: 'POST' as const,
        path: '/api/events/current/calendar/notices/control', input: 'body' as const,
        browserResumption: { kind: 'none' as const }, projection: refs.controlProjection
      }]
    }])
  }) });
}
