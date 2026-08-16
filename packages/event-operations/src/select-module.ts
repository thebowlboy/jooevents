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
  EVENT_OPERATION_SCHEMA_REFS,
  createSafeSchemaManifestRef,
  eventSelectInputSchema,
  eventSelectOperationResultSchema,
  eventSelectResultSchema,
  structuredOutcomeSchema,
  type SafeSchemaManifestRef,
  type StructuredOutcome,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import {
  eventSelectResult,
  parseEventSelectPlan,
  type EventSelectPlan
} from '@jooevents/event';
import {
  CURRENT_AUTHORITY_DENIAL_REASONS,
  parseOperationAccessLane,
  type CurrentAuthorityDenialReason,
  type CurrentAuthorityResolver,
  type VersionedAccessPolicyRef,
  type VersionedKeyProfileRef
} from '@jooevents/identity-access';
import {
  canonicalJsonText,
  parseInstant,
  parseWorkspaceId,
  type Clock,
  type InvocationId,
  type WorkspaceId
} from '@jooevents/kernel';
import { z } from 'zod';
import { EVENT_MANAGE_ACCESS_POLICY } from './module';
import { createEventSelectHandler } from './preparation';

export const EVENT_SELECT_OPERATION = Object.freeze({ name: 'event.select', version: 1 });
export const EVENT_SELECT_PATH = '/api/events/select';
export const EVENT_SELECT_HANDLER_CAPABILITY = ref('capability.event.select');
export const EVENT_SELECT_REQUEST_HASH_PROFILE = ref('request-hash.event.select');

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

function workspaceScope(workspaceId: WorkspaceId): InvocationScopeResolver {
  return Object.freeze({
    resolve: () => Object.freeze({
      workspaceId,
      subjects: Object.freeze([{ kind: 'workspace' as const, id: workspaceId }]),
      resolutionEvidenceIds: Object.freeze(['workspace.current'])
    })
  });
}

const nullDetailSchema = z.null();
const planSchema = z.custom<EventSelectPlan>((value) => {
  try {
    parseEventSelectPlan(value);
    return true;
  } catch {
    return false;
  }
}, { message: 'invalid_event_select_plan' });
export const eventSelectCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: eventSelectResultSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
export const eventSelectDomainContributionSchema = z.strictObject({
  kind: z.literal('event_select'),
  plan: planSchema
});
const successContributionSchema = z.strictObject({
  result: z.strictObject({ kind: z.literal('success'), data: eventSelectResultSchema }),
  domain: eventSelectDomainContributionSchema,
  effectContributions: z.tuple([])
}).superRefine((contribution, context) => {
  let plan: EventSelectPlan;
  try {
    plan = parseEventSelectPlan(contribution.domain.plan);
  } catch {
    context.addIssue({ code: 'custom', message: 'Invalid Event selection plan.' });
    return;
  }
  if (canonicalJsonText(contribution.result.data) !== canonicalJsonText(eventSelectResult(plan))) {
    context.addIssue({ code: 'custom', message: 'Event selection contribution is incoherent.' });
  }
});
const outcomeContributionSchema = z.strictObject({
  result: z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema }),
  domain: z.null(),
  effectContributions: z.tuple([])
}).superRefine((contribution, context) => {
  const key = `${contribution.result.outcome.class}:${contribution.result.outcome.kind}`;
  if (![
    'stale_revision:event.event_set_changed',
    'conflict:event.already_selected',
    'conflict:event.not_found'
  ].includes(key) || contribution.result.outcome.retryable !== false
      || contribution.result.outcome.detail !== null
      || contribution.result.outcome.detailSchemaVersion !== 1) {
    context.addIssue({ code: 'custom', message: 'Event selection outcome is not a domain refusal.' });
  }
});
export const eventSelectContributionSchema = z.union([
  successContributionSchema,
  outcomeContributionSchema
]);

export function createEventSelectOperationModule(input: {
  readonly workspaceId: WorkspaceId;
  readonly managePolicy: VersionedAccessPolicyRef;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly clock: Clock;
  readonly ids: { newInvocationId(): InvocationId };
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
  readonly requestHashSealer: RequestHashSealer;
  readonly idempotencyCredentialProfile: VersionedKeyProfileRef;
  readonly idempotencyCredentialSealer: IdempotencyCredentialSealer;
}): OperationRegistryModule {
  if (input.managePolicy.key !== EVENT_MANAGE_ACCESS_POLICY.key
      || input.managePolicy.version !== EVENT_MANAGE_ACCESS_POLICY.version) {
    throw new TypeError('event_select_policy_catalog_mismatch');
  }
  const workspaceId = parseWorkspaceId(input.workspaceId);
  const lane = parseOperationAccessLane({
    kind: 'operator', surface: 'operator_http', policy: input.managePolicy
  });
  const refs = {
    autonomy: ref('autonomy.event.select'), context: ref('context.event.select'),
    handler: ref('handler.event.select'), projection: ref('projection.event.select.operator'),
    audit: ref('audit.event.select'), record: ref('record-profile.event.select.operation-audit'),
    keySource: ref('idempotency.operator-header'),
    concurrency: ref('concurrency.event.workspace-event-set'),
    family: ref('event.select.execution-family'), phase: ref('event.select.phase.single-uow'),
    terminalization: ref('event.select.terminalization'), risk: ref('event.select.risk-resolver'),
    evidence: ref('event.select.autonomy-evidence'), approval: ref('event.select.approval-resolver'),
    preflight: ref('event.select.autonomy-preflight')
  } as const;
  const schemas = {
    input: EVENT_OPERATION_SCHEMA_REFS.select.inputSchema,
    contribution: schemaRef('schema.event.select.contribution', eventSelectContributionSchema),
    canonical: schemaRef('schema.event.select.canonical-result', eventSelectCanonicalResultSchema),
    projected: EVENT_OPERATION_SCHEMA_REFS.select.resultSchema,
    nullDetail: schemaRef('schema.event.select.null-detail', nullDetailSchema)
  } as const;
  const policy = createOperationAutonomyPolicy({
    definition: refs.autonomy,
    operation: EVENT_SELECT_OPERATION,
    riskFloor: 'normal', unattendedRiskCeiling: 'normal',
    supportedDispositions: [
      'proceed', 'safe_retry', 'reconcile', 'renewed_approval',
      'replan', 'compensate', 'block', 'attention'
    ],
    triggerDispositions: {
      authority_lost: 'block', unattended_bounds_exceeded: 'renewed_approval',
      approval_required: 'renewed_approval', known_retryable_failure: 'safe_retry',
      ambiguous_external_effect: 'reconcile', stale_plan: 'replan',
      compensation_required: 'compensate', terminal_failure: 'attention'
    }, requiresSeparateApproval: false
  });
  const context = createEffectInvocationContextBuilder({
    reference: refs.context,
    operation: EVENT_SELECT_OPERATION,
    effect: 'commit', lanes: [lane],
    scopeResolver: workspaceScope(workspaceId),
    authorityResolver: input.currentAuthority,
    clock: input.clock,
    newInvocationId: input.ids.newInvocationId,
    authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
    scopePartitionProfile: input.scopePartitionProfile,
    requestCanonicalizationProfile: input.requestCanonicalizationProfile,
    requestHashProfile: EVENT_SELECT_REQUEST_HASH_PROFILE,
    requestHashSealer: input.requestHashSealer,
    idempotencyCredentialProfile: input.idempotencyCredentialProfile,
    idempotencyCredentialSealer: input.idempotencyCredentialSealer,
    deniedAuthorityOutcome: authorityOutcome
  });
  const family = createSingleUnitOfWorkFamilyRegistration({
    reference: refs.family, phase: refs.phase
  });
  const terminalization = createTerminalizationResolverRegistration({
    reference: refs.terminalization,
    operation: EVENT_SELECT_OPERATION,
    phase: refs.phase,
    resolve: ({ result }) => result.kind === 'success'
      ? Object.freeze({ kind: 'terminal' as const })
      : Object.freeze({ kind: 'nonterminal' as const })
  });
  const phase = createSingleUnitOfWorkPhaseRegistration({
    reference: refs.phase,
    family: refs.family,
    operation: EVENT_SELECT_OPERATION,
    effect: 'commit',
    handler: refs.handler,
    handlerCapability: EVENT_SELECT_HANDLER_CAPABILITY,
    contributionSchema: schemas.contribution,
    terminalization: refs.terminalization,
    terminalOutcomeKeys: [],
    contentionOutcome: {
      class: 'conflict', kind: 'operation.in_progress', retryable: true,
      subjects: [], detail: null, detailSchemaVersion: 1
    }
  });
  const risk = createOperationRiskResolverRegistration({
    reference: refs.risk,
    operation: EVENT_SELECT_OPERATION,
    resolve: () => ({
      risk: 'normal',
      consequenceTags: ['workspace-current-event-changed'],
      evidenceIds: ['event.select.risk']
    })
  });
  const evidence = createAutonomyEvidenceResolverRegistration({
    reference: refs.evidence,
    operation: EVENT_SELECT_OPERATION,
    resolve: ({ subject }) => {
      const bounds = Object.freeze({
        scopeKeys: Object.freeze([...subject.scopeKeys]), maximumSpendMicros: 0,
        maximumActions: 1,
        notAfter: parseInstant(new Date(Date.parse(subject.evaluatedAt) + 60_000).toISOString())
      });
      return Object.freeze({
        evaluatedAt: subject.evaluatedAt, hardBounds: bounds, unattendedBounds: bounds,
        spendMicros: 0, actionCount: 1, completesBy: subject.evaluatedAt,
        proposedAction: {
          key: 'event.select.execute', version: 1, digestSha256: subject.requestHashSha256
        },
        failure: { kind: 'none' as const }
      });
    }
  });
  const approval = createRenewedApprovalResolverRegistration({
    reference: refs.approval,
    operation: EVENT_SELECT_OPERATION,
    resolve: () => ({ approverCurrentlyAuthorized: false })
  });
  const preflight = createAutonomyPreflightRegistration({
    reference: refs.preflight,
    operation: EVENT_SELECT_OPERATION,
    policy: refs.autonomy,
    riskResolver: refs.risk,
    evidenceResolver: refs.evidence,
    approvalResolver: refs.approval,
    interventionOutcomes: autonomyInterventionOutcomes(1)
  });
  const handler = createEventSelectHandler({
    reference: refs.handler,
    handlerCapability: EVENT_SELECT_HANDLER_CAPABILITY,
    contributionSchema: schemas.contribution,
    canonicalResultSchema: schemas.canonical
  });
  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => ({
    class: 'access_denied' as const, kind: `authority.${reason}`, retryable: false,
    detailSchema: schemas.nullDetail
  }));
  return Object.freeze({
    id: 'event.select.operations',
    source: Object.freeze({
      effectExecutionFamilies: [family], effectPhases: [phase],
      terminalizationResolvers: [terminalization], riskResolvers: [risk],
      autonomyEvidenceResolvers: [evidence], renewedApprovalResolvers: [approval],
      autonomyPreflights: [preflight], autonomyPolicies: [policy],
      schemas: [
        { reference: schemas.input, schema: eventSelectInputSchema },
        { reference: schemas.contribution, schema: eventSelectContributionSchema },
        { reference: schemas.canonical, schema: eventSelectCanonicalResultSchema },
        { reference: schemas.projected, schema: eventSelectOperationResultSchema },
        { reference: schemas.nullDetail, schema: nullDetailSchema }
      ],
      contextBuilders: [], readCapabilities: [], handlers: [], operations: [],
      readOperationalTraceTargets: [],
      projections: [{
        reference: refs.projection,
        canonicalResultSchema: schemas.canonical,
        projectedResultSchema: schemas.projected,
        project: (candidate: unknown) => eventSelectCanonicalResultSchema.parse(candidate)
      }],
      operationAuditTargets: [{
        reference: refs.audit, kind: 'operation_audit_record' as const, recordProfile: refs.record
      }],
      operationAuditRecordProfiles: [{
        reference: refs.record, kind: 'canonical_json' as const, maximumBytes: 65_536
      }],
      effectContextBuilders: [context], effectHandlers: [handler], effectOperations: [{
        ...EVENT_SELECT_OPERATION,
        lifecycle: { status: 'active' as const },
        summary: 'Select the current Event for the active workspace.',
        effect: 'commit' as const,
        maxRisk: 'normal' as const,
        autonomyPolicy: refs.autonomy,
        consequenceTags: ['workspace-current-event-changed'],
        agentAction: {
          eligible: true as const,
          displayLabel: 'Select an event',
          consequences: ['The selected event becomes current for workspace collaborators.'],
          externalEffect: 'none' as const
        },
        inputSchema: schemas.input,
        contributionSchema: schemas.contribution,
        canonicalResultSchema: schemas.canonical,
        outcomes: [
          { class: 'idempotency_conflict' as const, kind: 'operation.request_changed', retryable: false, detailSchema: schemas.nullDetail },
          ...accessOutcomes,
          { class: 'stale_revision' as const, kind: 'event.event_set_changed', retryable: false, detailSchema: schemas.nullDetail },
          { class: 'conflict' as const, kind: 'event.already_selected', retryable: false, detailSchema: schemas.nullDetail },
          { class: 'conflict' as const, kind: 'event.not_found', retryable: false, detailSchema: schemas.nullDetail },
          { class: 'conflict' as const, kind: 'operation.in_progress', retryable: true, detailSchema: schemas.nullDetail },
          ...autonomyInterventionOutcomeDeclarations(schemas.nullDetail)
        ],
        accessLanes: [lane],
        contextBuilder: refs.context,
        handlerCapability: EVENT_SELECT_HANDLER_CAPABILITY,
        handler: refs.handler,
        audit: { mode: 'required' as const, target: refs.audit },
        idempotency: {
          keySource: refs.keySource,
          credentialVerifierProfile: input.idempotencyCredentialProfile,
          requestHashProfile: EVENT_SELECT_REQUEST_HASH_PROFILE
        },
        concurrency: refs.concurrency,
        execution: {
          kind: 'single_unit_of_work' as const,
          profile: 'direct_audited' as const,
          family: refs.family,
          phase: refs.phase,
          terminalization: refs.terminalization,
          autonomyPreflight: refs.preflight,
          history: { summary: 'Selected an event' }
        },
        bindings: [{
          surface: 'operator_http' as const,
          method: 'POST' as const,
          path: EVENT_SELECT_PATH,
          input: 'body' as const,
          browserResumption: { kind: 'none' as const },
          projection: refs.projection
        }]
      }]
    })
  });
}
