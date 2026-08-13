import {
  CURRENT_AUTHORITY_DENIAL_REASONS,
  parseOperationAccessLane,
  type CurrentAuthorityDenialReason,
  type CurrentAuthorityResolver,
  type OperationAccessLane,
  type VersionedAccessPolicyRef,
  type VersionedKeyProfileRef
} from '@jooevents/identity-access';
import {
  autonomyInterventionOutcomeDeclarations,
  autonomyInterventionOutcomes,
  createAutonomyEvidenceResolverRegistration,
  createEffectInvocationContextBuilder,
  createOperationAutonomyPolicy,
  createOperationRiskResolverRegistration,
  createReadInvocationContextBuilder,
  createRenewedApprovalResolverRegistration,
  createSingleUnitOfWorkFamilyRegistration,
  createSingleUnitOfWorkPhaseRegistration,
  createTerminalizationResolverRegistration,
  createAutonomyPreflightRegistration,
  isSealedInvocationContext,
  type EffectHandlerRegistration,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type IdempotencyCredentialSealer,
  type InvocationEvidence,
  type InvocationScopeResolver,
  type OperationRegistryModule,
  type ReadCapabilityRegistration,
  type ReadInvocationContext,
  type RequestHashSealer
} from '@jooevents/application';
import {
  SUBMISSION_TRIAGE_OPERATION_SCHEMA_REFS,
  submissionTriageDraftCanonicalResultSchema,
  submissionTriageDraftDataSchema,
  submissionTriageDraftOperationResultSchema,
  submissionTriageListCanonicalResultSchema,
  submissionTriageListInputSchema,
  submissionTriageListOperationResultSchema,
  submissionTriageReadCanonicalResultSchema,
  submissionTriageReadInputSchema,
  submissionTriageReadOperationResultSchema,
  submissionTriageSafeDiffSchema,
  submissionTriageTransitionDraftInputSchema,
  type SubmissionTriageDraftData,
  type SubmissionTriageTransitionDraftInput
} from '@jooevents/contracts/submission-triage';
import {
  createSafeSchemaManifestRef,
  intakeDigestSchema,
  intakeIdInputSchema,
  structuredOutcomeSchema,
  type SafeSchemaManifestRef,
  type StructuredOutcome,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
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
  projectSubmissionTriageList,
  projectSubmissionTriageRead,
  type SubmissionTriageReadPort,
  type SubmissionTriageScope,
  type SubmissionTriageStateSnapshot
} from './model';
import {
  SUBMISSION_TRIAGE_MANAGE_ACCESS_POLICY,
  SUBMISSION_TRIAGE_MCP_READ_ACCESS_POLICY,
  SUBMISSION_TRIAGE_OPERATOR_READ_ACCESS_POLICY
} from './policy';

export const SUBMISSION_TRIAGE_LIST_OPERATION = Object.freeze({
  name: 'submission.triage.list', version: 1
});
export const SUBMISSION_TRIAGE_READ_OPERATION = Object.freeze({
  name: 'submission.triage.read', version: 1
});
export const SUBMISSION_TRIAGE_DRAFT_OPERATION = Object.freeze({
  name: 'submission.triage.transition.draft', version: 1
});

export const SUBMISSION_TRIAGE_DRAFT_HANDLER_CAPABILITY = ref(
  'capability.submission.triage.changeset-draft'
);
export const SUBMISSION_TRIAGE_DRAFT_REQUEST_HASH_PROFILE = ref(
  'request-hash.submission.triage.draft'
);

export const SUBMISSION_TRIAGE_HTTP_PATHS = Object.freeze({
  list: '/api/events/current/submissions/triage',
  read: '/api/events/current/submissions/triage/detail',
  draft: '/api/events/current/submissions/triage/drafts'
});
export const SUBMISSION_TRIAGE_MCP_TOOLS = Object.freeze({
  list: 'submission_triage_list',
  read: 'submission_triage_read'
});

export interface SubmissionTriageOperationIds {
  newInvocationId(): InvocationId;
}

export interface SubmissionTriageCurrentEventSource {
  resolveCurrentEvent(workspaceId: WorkspaceId):
    | { readonly eventId?: string; readonly evidenceIds: readonly string[] }
    | Promise<{ readonly eventId?: string; readonly evidenceIds: readonly string[] }>;
}

export interface SubmissionTriageOperationCrypto {
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
  readonly requestHashSealer: RequestHashSealer;
  readonly idempotencyCredentialProfile: VersionedKeyProfileRef;
  readonly idempotencyCredentialSealer: IdempotencyCredentialSealer;
}

export interface SubmissionTriageOperationPolicies {
  readonly operatorRead: VersionedAccessPolicyRef;
  readonly externalMcpRead: VersionedAccessPolicyRef;
  readonly manage: VersionedAccessPolicyRef;
}

export interface SubmissionTriagePreparedContribution {
  readonly result: unknown;
  readonly domain: unknown;
  readonly receiptChildren: readonly unknown[];
}

export interface SubmissionTriageDraftPreparation {
  prepare(input: {
    readonly businessInput: SubmissionTriageTransitionDraftInput;
    readonly context: EffectInvocationContext;
  }): SubmissionTriagePreparedContribution;
}

interface SealedPreparation {
  readonly capability: VersionedDefinitionRef;
  readonly context: EffectInvocationContext;
  readonly prepare: SubmissionTriageDraftPreparation['prepare'];
  phase: 'ready' | 'preparing' | 'spent';
}

const sealedPreparations = new WeakMap<object, SealedPreparation>();

export function sealSubmissionTriageDraftPreparation(input: {
  readonly capability: VersionedDefinitionRef;
  readonly context: EffectInvocationContext;
  readonly preparation: SubmissionTriageDraftPreparation;
}): EffectHandlerSnapshot {
  if (!isSealedInvocationContext(input.context) || input.context.operation.effect !== 'draft') {
    throw new TypeError('submission_triage_preparation_context_invalid');
  }
  if (typeof input.preparation.prepare !== 'function') {
    throw new TypeError('submission_triage_preparation_invalid');
  }
  if (input.preparation.prepare.constructor.name === 'AsyncFunction') {
    throw new TypeError('submission_triage_preparation_must_be_synchronous');
  }
  const snapshot = Object.freeze({ strategy: 'submission_triage', version: 1 });
  sealedPreparations.set(snapshot, {
    capability: Object.freeze({ ...input.capability }),
    context: input.context,
    prepare: input.preparation.prepare.bind(input.preparation),
    phase: 'ready'
  });
  return snapshot;
}

function createDraftHandler(input: {
  readonly reference: VersionedDefinitionRef;
  readonly contributionSchema: SafeSchemaManifestRef;
  readonly canonicalResultSchema: SafeSchemaManifestRef;
}): EffectHandlerRegistration {
  const capability = SUBMISSION_TRIAGE_DRAFT_HANDLER_CAPABILITY;
  return Object.freeze({
    reference: input.reference,
    effect: 'draft' as const,
    handlerCapability: capability,
    contributionSchema: input.contributionSchema,
    canonicalResultSchema: input.canonicalResultSchema,
    handle({ businessInput, context, snapshot }:
      Parameters<EffectHandlerRegistration['handle']>[0]) {
      const sealed = sealedPreparations.get(snapshot);
      if (!sealed
          || !sameReference(sealed.capability, capability)
          || sealed.context !== context
          || context.operation.effect !== 'draft'
          || sealed.phase !== 'ready') {
        throw new TypeError('invalid_submission_triage_preparation');
      }
      const parsed = submissionTriageTransitionDraftInputSchema.parse(businessInput);
      sealed.phase = 'preparing';
      try {
        const contribution = sealed.prepare({ businessInput: parsed, context });
        if (contribution
            && typeof (contribution as { readonly then?: unknown }).then === 'function') {
          throw new TypeError('submission_triage_preparation_must_be_synchronous');
        }
        sealed.phase = 'spent';
        return contribution;
      } catch (error) {
        sealed.phase = 'spent';
        throw error;
      }
    }
  });
}

const canonicalUuid = z.uuid().refine((value) => value === value.toLowerCase());

export const submissionTriageDraftDomainContributionSchema = z.strictObject({
  kind: z.literal('submission_triage_changeset_draft'),
  preparationHandle: canonicalUuid,
  workspaceId: canonicalUuid,
  eventId: canonicalUuid,
  action: z.enum(['set_aside', 'return_to_inbox', 'discard_recoverable', 'restore']),
  changesetId: canonicalUuid,
  revisionId: canonicalUuid,
  revisionDigestSha256: intakeDigestSchema,
  recordDigestSha256: intakeDigestSchema,
  occurredAt: z.iso.datetime({ offset: true })
});

export const submissionTriageDraftEvidenceChildSchema = z.strictObject({
  kind: z.literal('timeline'),
  timelineId: canonicalUuid,
  sourceKind: z.literal('changeset_revision'),
  workspaceId: canonicalUuid,
  eventId: canonicalUuid,
  changesetId: canonicalUuid,
  revisionId: canonicalUuid,
  occurredAt: z.iso.datetime({ offset: true })
});

export const submissionTriageDraftRefusalDetailSchema = z.strictObject({
  code: z.enum([
    'wrong_scope', 'projection_incomplete', 'source_changed', 'submission_missing',
    'stale_query_set', 'stale_submission', 'invalid_transition', 'invalid_plan'
  ]),
  action: z.enum([
    'set_aside', 'return_to_inbox', 'discard_recoverable', 'restore', 'restore_exact'
  ]),
  submissionIds: z.array(intakeIdInputSchema).min(1).max(200)
});

const draftSuccessContributionSchema = z.strictObject({
  result: z.strictObject({ kind: z.literal('success'), data: submissionTriageDraftDataSchema }),
  domain: submissionTriageDraftDomainContributionSchema,
  receiptChildren: z.tuple([submissionTriageDraftEvidenceChildSchema])
}).superRefine((value, context) => {
  const data = value.result.data;
  const domain = value.domain;
  const timeline = value.receiptChildren[0];
  if (data.action !== domain.action
      || data.changesetId !== domain.changesetId
      || data.revision.id !== domain.revisionId
      || data.revision.digestSha256 !== domain.revisionDigestSha256
      || timeline.workspaceId !== domain.workspaceId
      || timeline.eventId !== domain.eventId
      || timeline.changesetId !== domain.changesetId
      || timeline.revisionId !== domain.revisionId
      || timeline.occurredAt !== domain.occurredAt) {
    context.addIssue({ code: 'custom', message: 'triage draft evidence is incoherent' });
  }
});

const draftOutcomeContributionSchema = z.strictObject({
  result: z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema }),
  domain: z.null(),
  receiptChildren: z.tuple([])
}).superRefine((value, context) => {
  const outcome = value.result.outcome;
  const allowed = new Set([
    'conflict:submission_triage.event_required',
    'stale_revision:submission_triage.changed',
    'policy_violation:submission_triage.change_refused',
    'conflict:changeset.id_collision'
  ]);
  const detailSchema = outcome.kind === 'submission_triage.changed'
      || outcome.kind === 'submission_triage.change_refused'
    ? submissionTriageDraftRefusalDetailSchema
    : z.null();
  if (!allowed.has(`${outcome.class}:${outcome.kind}`)
      || outcome.retryable
      || outcome.detailSchemaVersion !== 1
      || !detailSchema.safeParse(outcome.detail).success) {
    context.addIssue({ code: 'custom', message: 'triage draft refusal is invalid' });
  }
});

export const submissionTriageDraftContributionSchema = z.union([
  draftSuccessContributionSchema,
  draftOutcomeContributionSchema
]);

interface ReadSnapshot extends Readonly<Record<string, unknown>> {
  readonly scope: SubmissionTriageScope | null;
  readonly state: SubmissionTriageStateSnapshot | undefined;
  readonly sourceRows: readonly ReturnType<SubmissionTriageReadPort['listSourceRows']>[number][];
}

function ref(key: string): VersionedDefinitionRef {
  return Object.freeze({ key, version: parseContractVersion(1) });
}

function schemaRef(key: string, schema: z.ZodType): SafeSchemaManifestRef {
  return createSafeSchemaManifestRef(key, schema, parseContractVersion(1));
}

function sameReference(left: VersionedDefinitionRef, right: VersionedDefinitionRef): boolean {
  return left.key === right.key && left.version === right.version;
}

function assertPolicy(
  actual: VersionedAccessPolicyRef,
  expected: VersionedAccessPolicyRef,
  code: string
): void {
  if (!sameReference(actual, expected)) throw new TypeError(code);
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
        || value.trim() !== value) throw new TypeError('submission_triage_scope_evidence_invalid');
    return value;
  });
  return Object.freeze([...new Set(parsed)].sort());
}

function eventScope(
  workspaceId: WorkspaceId,
  source: SubmissionTriageCurrentEventSource
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

function eventRequired(context: ReadInvocationContext): SubmissionTriageScope | null {
  return context.scope.eventId
    ? { workspaceId: context.scope.workspaceId, eventId: context.scope.eventId }
    : null;
}

function operatorLane(policy: VersionedAccessPolicyRef) {
  const lane = parseOperationAccessLane({ kind: 'operator', surface: 'operator_http', policy });
  if (lane.kind !== 'operator') throw new TypeError('submission_triage_operator_lane_invalid');
  return lane;
}

function mcpLane(policy: VersionedAccessPolicyRef) {
  const lane = parseOperationAccessLane({ kind: 'external_mcp', surface: 'external_mcp', policy });
  if (lane.kind !== 'external_mcp') throw new TypeError('submission_triage_mcp_lane_invalid');
  return lane;
}

function autonomy(
  operation: { readonly name: string; readonly version: number },
  definition: VersionedDefinitionRef,
  risk: 'low' | 'normal'
) {
  return createOperationAutonomyPolicy({
    definition,
    operation,
    riskFloor: risk,
    unattendedRiskCeiling: risk,
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

export function createSubmissionTriageReadOperationModule(input: {
  readonly workspaceId: WorkspaceId;
  readonly policies: Pick<SubmissionTriageOperationPolicies, 'operatorRead' | 'externalMcpRead'>;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly currentEvent: SubmissionTriageCurrentEventSource;
  readonly read: SubmissionTriageReadPort;
  readonly clock: Clock;
  readonly ids: SubmissionTriageOperationIds;
  readonly crypto: Pick<SubmissionTriageOperationCrypto,
    'authorityPrincipalKeyProfile' | 'scopePartitionProfile' | 'requestCanonicalizationProfile'>;
}): OperationRegistryModule {
  assertPolicy(input.policies.operatorRead, SUBMISSION_TRIAGE_OPERATOR_READ_ACCESS_POLICY,
    'submission_triage_operator_read_policy_catalog_mismatch');
  assertPolicy(input.policies.externalMcpRead, SUBMISSION_TRIAGE_MCP_READ_ACCESS_POLICY,
    'submission_triage_mcp_read_policy_catalog_mismatch');
  const workspaceId = parseWorkspaceId(input.workspaceId);
  const lanes = [operatorLane(input.policies.operatorRead), mcpLane(input.policies.externalMcpRead)];
  const scopeResolver = eventScope(workspaceId, input.currentEvent);
  const entries = [
    {
      operation: SUBMISSION_TRIAGE_LIST_OPERATION,
      inputSchema: submissionTriageListInputSchema,
      canonicalSchema: submissionTriageListCanonicalResultSchema,
      projectedSchema: submissionTriageListOperationResultSchema,
      inputRef: SUBMISSION_TRIAGE_OPERATION_SCHEMA_REFS.list.inputSchema,
      projectedRef: SUBMISSION_TRIAGE_OPERATION_SCHEMA_REFS.list.resultSchema,
      path: SUBMISSION_TRIAGE_HTTP_PATHS.list,
      toolName: SUBMISSION_TRIAGE_MCP_TOOLS.list,
      read: (snapshot: ReadSnapshot, raw: unknown) => {
        if (!snapshot.scope) return readOutcome('submission_triage.event_required');
        if (!snapshot.state) return readOutcome('submission_triage.not_initialized');
        return {
          kind: 'success' as const,
          data: projectSubmissionTriageList({
            state: snapshot.state,
            sourceRows: snapshot.sourceRows,
            query: submissionTriageListInputSchema.parse(raw)
          })
        };
      }
    },
    {
      operation: SUBMISSION_TRIAGE_READ_OPERATION,
      inputSchema: submissionTriageReadInputSchema,
      canonicalSchema: submissionTriageReadCanonicalResultSchema,
      projectedSchema: submissionTriageReadOperationResultSchema,
      inputRef: SUBMISSION_TRIAGE_OPERATION_SCHEMA_REFS.read.inputSchema,
      projectedRef: SUBMISSION_TRIAGE_OPERATION_SCHEMA_REFS.read.resultSchema,
      path: SUBMISSION_TRIAGE_HTTP_PATHS.read,
      toolName: SUBMISSION_TRIAGE_MCP_TOOLS.read,
      read: (snapshot: ReadSnapshot, raw: unknown) => {
        if (!snapshot.scope) return readOutcome('submission_triage.event_required');
        if (!snapshot.state) return readOutcome('submission_triage.not_initialized');
        const { submissionId } = submissionTriageReadInputSchema.parse(raw);
        const found = projectSubmissionTriageRead({
          state: snapshot.state,
          sourceRows: snapshot.sourceRows,
          submissionId
        });
        return found
          ? { kind: 'success' as const, data: found }
          : readOutcome('submission_triage.not_found');
      }
    }
  ] as const;
  const nullDetail = z.null();
  const nullDetailRef = schemaRef('schema.submission.triage.read.null-detail', nullDetail);
  const capabilityRef = ref('capability.submission.triage.read');
  const traceRef = ref('trace.submission.triage.read');
  const auditRef = ref('audit.submission.triage.read');
  const recordProfile = ref('record-profile.submission.triage.read-audit');
  const capability: ReadCapabilityRegistration = Object.freeze({
    reference: capabilityRef,
    openSnapshot(context: ReadInvocationContext) {
      const currentScope = eventRequired(context);
      if (!currentScope) return Object.freeze({
        scope: null, state: undefined, sourceRows: Object.freeze([])
      });
      return Object.freeze({
        scope: currentScope,
        state: input.read.readTriageState(currentScope),
        sourceRows: input.read.listSourceRows(currentScope)
      });
    }
  });
  const built = entries.map((entry) => {
    const refs = {
      context: ref(`context.${entry.operation.name}`),
      autonomy: ref(`autonomy.${entry.operation.name}`),
      handler: ref(`handler.${entry.operation.name}`),
      projection: ref(`projection.${entry.operation.name}`),
      canonical: schemaRef(
        `schema.${entry.operation.name}.canonical-result`, entry.canonicalSchema
      )
    };
    return {
      ...entry,
      refs,
      autonomy: autonomy(entry.operation, refs.autonomy, 'low'),
      context: createReadInvocationContextBuilder({
        reference: refs.context,
        operation: entry.operation,
        effect: 'read',
        lanes,
        scopeResolver,
        authorityResolver: input.currentAuthority,
        clock: input.clock,
        newInvocationId: input.ids.newInvocationId,
        authorityPrincipalKeyProfile: input.crypto.authorityPrincipalKeyProfile,
        scopePartitionProfile: input.crypto.scopePartitionProfile,
        requestCanonicalizationProfile: input.crypto.requestCanonicalizationProfile,
        deniedAuthorityOutcome: authorityOutcome
      })
    };
  });
  const accessOutcomes = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => ({
    class: 'access_denied' as const,
    kind: `authority.${reason}`,
    retryable: false,
    detailSchema: nullDetailRef
  }));
  return Object.freeze({
    id: 'submission-triage.read-operations',
    source: Object.freeze({
      autonomyPolicies: built.map((entry) => entry.autonomy),
      schemas: [
        ...built.flatMap((entry) => [
          { reference: entry.inputRef, schema: entry.inputSchema },
          { reference: entry.refs.canonical, schema: entry.canonicalSchema },
          { reference: entry.projectedRef, schema: entry.projectedSchema }
        ]),
        { reference: nullDetailRef, schema: nullDetail }
      ],
      contextBuilders: built.map((entry) => entry.context),
      readCapabilities: [capability],
      handlers: built.map((entry) => ({
        reference: entry.refs.handler,
        readCapability: capabilityRef,
        canonicalResultSchema: entry.refs.canonical,
        handle: ({ businessInput, snapshot }: {
          readonly businessInput: unknown;
          readonly snapshot: Readonly<Record<string, unknown>>;
        }) => entry.read(snapshot as ReadSnapshot, businessInput)
      })),
      projections: built.map((entry) => ({
        reference: entry.refs.projection,
        canonicalResultSchema: entry.refs.canonical,
        projectedResultSchema: entry.projectedRef,
        project: (candidate: unknown) => entry.canonicalSchema.parse(candidate)
      })),
      readOperationalTraceTargets: [{
        reference: traceRef,
        kind: 'read_operational_trace_record' as const,
        recordProfile
      }],
      operationAuditTargets: [{
        reference: auditRef,
        kind: 'operation_audit_record' as const,
        recordProfile
      }],
      operationAuditRecordProfiles: [{
        reference: recordProfile,
        kind: 'canonical_json' as const,
        maximumBytes: 262_144
      }],
      operations: built.map((entry) => ({
        ...entry.operation,
        lifecycle: { status: 'active' as const },
        summary: `Read ${entry.operation.name}.`,
        effect: 'read' as const,
        maxRisk: 'low' as const,
        autonomyPolicy: entry.refs.autonomy,
        consequenceTags: [],
        inputSchema: entry.inputRef,
        canonicalResultSchema: entry.refs.canonical,
        outcomes: [
          ...accessOutcomes,
          { class: 'conflict' as const, kind: 'submission_triage.event_required', retryable: false, detailSchema: nullDetailRef },
          { class: 'conflict' as const, kind: 'submission_triage.not_initialized', retryable: false, detailSchema: nullDetailRef },
          { class: 'conflict' as const, kind: 'submission_triage.not_found', retryable: false, detailSchema: nullDetailRef }
        ],
        accessLanes: lanes,
        contextBuilder: entry.refs.context,
        readCapability: capabilityRef,
        handler: entry.refs.handler,
        observability: {
          trace: { mode: 'required' as const, target: traceRef },
          immutableAudit: { mode: 'external_mcp_app_model' as const, target: auditRef }
        },
        bindings: [{
          surface: 'operator_http' as const,
          method: 'GET' as const,
          path: entry.path,
          input: 'query' as const,
          browserResumption: { kind: 'none' as const },
          projection: entry.refs.projection
        }, {
          surface: 'external_mcp' as const,
          toolName: entry.toolName,
          projection: entry.refs.projection
        }]
      }))
    })
  });
}

function readOutcome(kind: string) {
  return {
    kind: 'outcome' as const,
    outcome: {
      class: 'conflict' as const,
      kind,
      retryable: false,
      subjects: [],
      detail: null,
      detailSchemaVersion: 1
    }
  };
}

export function createSubmissionTriageDraftOperationModule(input: {
  readonly workspaceId: WorkspaceId;
  readonly policy: VersionedAccessPolicyRef;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly currentEvent: SubmissionTriageCurrentEventSource;
  readonly clock: Clock;
  readonly ids: SubmissionTriageOperationIds;
  readonly crypto: SubmissionTriageOperationCrypto;
}): OperationRegistryModule {
  assertPolicy(input.policy, SUBMISSION_TRIAGE_MANAGE_ACCESS_POLICY,
    'submission_triage_manage_policy_catalog_mismatch');
  const workspaceId = parseWorkspaceId(input.workspaceId);
  const lane = operatorLane(input.policy);
  const operation = SUBMISSION_TRIAGE_DRAFT_OPERATION;
  const nullDetail = z.null();
  const refs = {
    input: SUBMISSION_TRIAGE_OPERATION_SCHEMA_REFS.draft.inputSchema,
    contribution: schemaRef(
      'schema.submission.triage-draft.contribution', submissionTriageDraftContributionSchema
    ),
    canonical: schemaRef(
      'schema.submission.triage-draft.canonical-result',
      submissionTriageDraftCanonicalResultSchema
    ),
    projected: SUBMISSION_TRIAGE_OPERATION_SCHEMA_REFS.draft.resultSchema,
    detail: schemaRef(
      'schema.submission.triage-draft.refusal-detail',
      submissionTriageDraftRefusalDetailSchema
    ),
    nullDetail: schemaRef('schema.submission.triage-draft.null-detail', nullDetail),
    context: ref('context.submission.triage.transition-draft'),
    handler: ref('handler.submission.triage.changeset-draft'),
    projection: ref('projection.submission.triage.changeset-draft.operator'),
    autonomy: ref('autonomy.submission.triage.transition-draft'),
    audit: ref('audit.submission.triage.changeset-draft'),
    auditProfile: ref('record-profile.submission.triage-draft.operation-audit'),
    keySource: ref('idempotency.operator-header'),
    concurrency: ref('concurrency.submission.triage.transition-draft'),
    family: ref('submission.triage.transition-draft.execution-family'),
    phase: ref('submission.triage.transition-draft.phase.single-uow'),
    terminalization: ref('submission.triage.transition-draft.terminalization'),
    risk: ref('submission.triage.transition-draft.risk-resolver'),
    evidence: ref('submission.triage.transition-draft.autonomy-evidence'),
    approval: ref('submission.triage.transition-draft.approval-resolver'),
    preflight: ref('submission.triage.transition-draft.autonomy-preflight')
  };
  const operationAutonomy = autonomy(operation, refs.autonomy, 'low');
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
    requestHashProfile: SUBMISSION_TRIAGE_DRAFT_REQUEST_HASH_PROFILE,
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
    handlerCapability: SUBMISSION_TRIAGE_DRAFT_HANDLER_CAPABILITY,
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
      evidenceIds: ['submission.triage.transition.draft.risk']
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
          key: 'submission.triage.transition.draft.execute',
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
  const handler = createDraftHandler({
    reference: refs.handler,
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
    id: 'submission-triage.draft-operation',
    source: Object.freeze({
      autonomyPolicies: [operationAutonomy],
      schemas: [
        { reference: refs.input, schema: submissionTriageTransitionDraftInputSchema },
        { reference: refs.contribution, schema: submissionTriageDraftContributionSchema },
        { reference: refs.canonical, schema: submissionTriageDraftCanonicalResultSchema },
        { reference: refs.projected, schema: submissionTriageDraftOperationResultSchema },
        { reference: refs.detail, schema: submissionTriageDraftRefusalDetailSchema },
        { reference: refs.nullDetail, schema: nullDetail },
        { reference: schemaRef('schema.submission.triage.safe-diff', submissionTriageSafeDiffSchema), schema: submissionTriageSafeDiffSchema }
      ],
      contextBuilders: [],
      readCapabilities: [],
      handlers: [],
      projections: [{
        reference: refs.projection,
        canonicalResultSchema: refs.canonical,
        projectedResultSchema: refs.projected,
        project: (candidate: unknown) => submissionTriageDraftCanonicalResultSchema.parse(candidate)
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
        summary: 'Draft bounded submission-triage transitions for review.',
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
          { class: 'conflict' as const, kind: 'submission_triage.event_required', retryable: false, detailSchema: refs.nullDetail },
          { class: 'stale_revision' as const, kind: 'submission_triage.changed', retryable: false, detailSchema: refs.detail },
          { class: 'policy_violation' as const, kind: 'submission_triage.change_refused', retryable: false, detailSchema: refs.detail },
          { class: 'conflict' as const, kind: 'changeset.id_collision', retryable: false, detailSchema: refs.nullDetail },
          { class: 'conflict' as const, kind: 'operation.in_progress', retryable: true, detailSchema: refs.nullDetail },
          ...autonomyInterventionOutcomeDeclarations(refs.nullDetail)
        ],
        accessLanes: [lane],
        contextBuilder: refs.context,
        handlerCapability: SUBMISSION_TRIAGE_DRAFT_HANDLER_CAPABILITY,
        handler: refs.handler,
        audit: { mode: 'required' as const, target: refs.audit },
        idempotency: {
          keySource: refs.keySource,
          credentialVerifierProfile: input.crypto.idempotencyCredentialProfile,
          requestHashProfile: SUBMISSION_TRIAGE_DRAFT_REQUEST_HASH_PROFILE
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
          path: SUBMISSION_TRIAGE_HTTP_PATHS.draft,
          input: 'body' as const,
          browserResumption: { kind: 'none' as const },
          projection: refs.projection
        }]
      }]
    })
  });
}
