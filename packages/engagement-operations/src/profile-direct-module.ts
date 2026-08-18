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
  type EffectHandlerRegistration,
  type EffectHandlerSnapshot,
  type EffectInvocationContext,
  type IdempotencyCredentialSealer,
  type InvocationEvidence,
  type OperationRegistryModule,
  type RequestHashSealer
} from '@jooevents/application';
import {
  SPEAKER_PROFILE_OPERATION_SCHEMA_REFS,
  createSafeSchemaManifestRef,
  speakerProfileApproveInputSchema,
  speakerProfileApprovePlanSchema,
  speakerProfileApproveResultSchema,
  speakerProfileUpdateInputSchema,
  speakerProfileUpdatePlanSchema,
  speakerProfileUpdateResultSchema,
  speakerProfileViewSchema,
  structuredOutcomeSchema,
  type StructuredOutcome,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import { SPEAKER_PROFILE_PLANNING_ERROR_CODES } from '@jooevents/engagement';
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
  parseInstant,
  parseWorkspaceId,
  type Clock,
  type WorkspaceId
} from '@jooevents/kernel';
import { z } from 'zod';
import {
  currentEventScopeResolver,
  type EngagementCurrentEventSource,
  type EngagementOperationIds
} from './module';

export const SPEAKER_PROFILE_UPDATE_OPERATION = Object.freeze({
  name: 'speaker.profile.update', version: 1
});
export const SPEAKER_PROFILE_APPROVE_OPERATION = Object.freeze({
  name: 'speaker.profile.approve', version: 1
});
export const SPEAKER_PROFILE_MANAGE_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.speaker-profile.manage', version: parseContractVersion(1)
});
export const SPEAKER_PROFILE_MANAGE_PERMISSION_ID: PermissionId = 'speaker.profile.manage';
export const SPEAKER_PROFILE_DIRECT_HANDLER_CAPABILITY = ref('capability.speaker-profile.direct');
export const SPEAKER_PROFILE_DIRECT_REQUEST_HASH_PROFILE = ref('request-hash.speaker-profile.direct');

const nullSchema = z.null();
export const speakerProfileChangedDetailSchema = z.strictObject({
  code: z.enum(SPEAKER_PROFILE_PLANNING_ERROR_CODES),
  field: z.enum(['headline', 'biography', 'location', 'links']).nullable()
});
export const speakerProfileDirectCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: speakerProfileViewSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
export const speakerProfileDirectContributionSchema = z.union([
  z.strictObject({
    result: z.strictObject({ kind: z.literal('success'), data: speakerProfileViewSchema }),
    domain: z.strictObject({
      kind: z.literal('speaker_profile_update_direct'),
      plan: speakerProfileUpdatePlanSchema
    }),
    effectContributions: z.tuple([])
  }),
  z.strictObject({
    result: z.strictObject({ kind: z.literal('success'), data: speakerProfileViewSchema }),
    domain: z.strictObject({
      kind: z.literal('speaker_profile_approve_direct'),
      plan: speakerProfileApprovePlanSchema
    }),
    effectContributions: z.tuple([])
  }),
  z.strictObject({
    result: z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema }),
    domain: z.null(),
    effectContributions: z.tuple([])
  })
]);

function ref(key: string): VersionedDefinitionRef {
  return Object.freeze({ key, version: 1 });
}

const common = Object.freeze({
  contribution: createSafeSchemaManifestRef(
    'schema.speaker-profile.direct.contribution', speakerProfileDirectContributionSchema
  ),
  canonical: createSafeSchemaManifestRef(
    'schema.speaker-profile.direct.canonical-result', speakerProfileDirectCanonicalResultSchema
  ),
  null: createSafeSchemaManifestRef('schema.speaker-profile.direct.null-detail', nullSchema),
  changed: createSafeSchemaManifestRef(
    'schema.speaker-profile.changed.detail', speakerProfileChangedDetailSchema
  ),
  handler: ref('handler.speaker-profile.direct'),
  audit: ref('audit.speaker-profile.direct'),
  auditProfile: ref('record-profile.speaker-profile.operation-audit'),
  keySource: ref('idempotency.operator-header')
});

const specs = Object.freeze([
  {
    key: 'update' as const,
    operation: SPEAKER_PROFILE_UPDATE_OPERATION,
    input: speakerProfileUpdateInputSchema,
    inputRef: SPEAKER_PROFILE_OPERATION_SCHEMA_REFS.update.inputSchema,
    result: speakerProfileUpdateResultSchema,
    resultRef: SPEAKER_PROFILE_OPERATION_SCHEMA_REFS.update.resultSchema,
    path: '/api/events/current/speakers/profile',
    summary: 'Update one exact Person speaker profile.',
    history: 'Updated a speaker profile',
    displayLabel: 'Update a speaker profile',
    consequence: 'Approved public-card fields may require approval again.'
  },
  {
    key: 'approve' as const,
    operation: SPEAKER_PROFILE_APPROVE_OPERATION,
    input: speakerProfileApproveInputSchema,
    inputRef: SPEAKER_PROFILE_OPERATION_SCHEMA_REFS.approve.inputSchema,
    result: speakerProfileApproveResultSchema,
    resultRef: SPEAKER_PROFILE_OPERATION_SCHEMA_REFS.approve.resultSchema,
    path: '/api/events/current/speakers/profile/approve',
    summary: 'Approve exact speaker profile field revisions for the current event.',
    history: 'Approved speaker profile fields',
    displayLabel: 'Approve speaker profile fields',
    consequence: 'Approved values may appear in the next published speaker card.'
  }
]);

interface SealedPreparation {
  readonly capability: VersionedDefinitionRef;
  readonly context: EffectInvocationContext;
  readonly prepare: SpeakerProfileDirectPreparation['prepare'];
  phase: 'ready' | 'preparing' | 'spent';
}
const sealedPreparations = new WeakMap<object, SealedPreparation>();
const sameRef = (left: VersionedDefinitionRef, right: VersionedDefinitionRef) =>
  left.key === right.key && left.version === right.version;

export interface SpeakerProfileDirectPreparation {
  prepare(input: {
    readonly businessInput: unknown;
    readonly context: EffectInvocationContext;
  }): { readonly result: unknown; readonly domain: unknown; readonly effectContributions: readonly unknown[] };
}

export function sealSpeakerProfileDirectPreparation(input: {
  readonly capability: VersionedDefinitionRef;
  readonly context: EffectInvocationContext;
  readonly preparation: SpeakerProfileDirectPreparation;
}): EffectHandlerSnapshot {
  if (typeof input.preparation.prepare !== 'function'
      || input.preparation.prepare.constructor.name === 'AsyncFunction') {
    throw new TypeError('speaker_profile_direct_preparation_invalid');
  }
  const snapshot = Object.freeze({ strategy: 'speaker_profile_direct', version: 1 });
  sealedPreparations.set(snapshot, {
    capability: Object.freeze({ ...input.capability }), context: input.context,
    prepare: input.preparation.prepare.bind(input.preparation), phase: 'ready'
  });
  return snapshot;
}

function createHandler(): EffectHandlerRegistration {
  const capability = SPEAKER_PROFILE_DIRECT_HANDLER_CAPABILITY;
  return Object.freeze({
    reference: common.handler,
    effect: 'commit' as const,
    handlerCapability: capability,
    contributionSchema: common.contribution,
    canonicalResultSchema: common.canonical,
    handle({ businessInput, context, snapshot }:
      Parameters<EffectHandlerRegistration['handle']>[0]) {
      const sealed = sealedPreparations.get(snapshot);
      if (!sealed || !sameRef(sealed.capability, capability)
          || sealed.context !== context || sealed.phase !== 'ready') {
        throw new TypeError('invalid_speaker_profile_direct_preparation');
      }
      sealed.phase = 'preparing';
      try {
        const contribution = sealed.prepare({ businessInput, context });
        if (contribution && typeof (contribution as { readonly then?: unknown }).then === 'function') {
          throw new TypeError('speaker_profile_direct_preparation_must_be_synchronous');
        }
        sealed.phase = 'spent';
        return {
          result: contribution.result,
          domain: contribution.domain,
          effectContributions: [...contribution.effectContributions]
        };
      } catch (error) {
        sealed.phase = 'spent';
        throw error;
      }
    }
  });
}

export interface CreateSpeakerProfileDirectOperationModuleInput {
  readonly workspaceId: WorkspaceId;
  readonly managePolicy: VersionedAccessPolicyRef;
  readonly currentAuthority: CurrentAuthorityResolver<InvocationEvidence>;
  readonly currentEvent: EngagementCurrentEventSource;
  readonly clock: Clock;
  readonly ids: EngagementOperationIds;
  readonly authorityPrincipalKeyProfile: VersionedKeyProfileRef;
  readonly scopePartitionProfile: VersionedKeyProfileRef;
  readonly requestCanonicalizationProfile: VersionedKeyProfileRef;
  readonly requestHashSealer: RequestHashSealer;
  readonly idempotencyCredentialProfile: VersionedKeyProfileRef;
  readonly idempotencyCredentialSealer: IdempotencyCredentialSealer;
}

function authorityOutcome(reason: CurrentAuthorityDenialReason): StructuredOutcome {
  return Object.freeze({
    class: 'access_denied', kind: `authority.${reason}`, retryable: false,
    subjects: [], detail: null, detailSchemaVersion: 1
  });
}

export function createSpeakerProfileDirectOperationModule(
  input: CreateSpeakerProfileDirectOperationModuleInput
): OperationRegistryModule {
  const workspaceId = parseWorkspaceId(input.workspaceId);
  if (!sameRef(input.managePolicy, SPEAKER_PROFILE_MANAGE_ACCESS_POLICY)) {
    throw new TypeError('speaker_profile_direct_policy_catalog_mismatch');
  }
  const lane = parseOperationAccessLane({
    kind: 'operator', surface: 'operator_http', policy: input.managePolicy
  });
  const scopeResolver = currentEventScopeResolver({ workspaceId, source: input.currentEvent });
  const access = CURRENT_AUTHORITY_DENIAL_REASONS.map((reason) => ({
    class: 'access_denied' as const, kind: `authority.${reason}`,
    retryable: false, detailSchema: common.null
  }));
  const contention = Object.freeze({
    class: 'conflict' as const, kind: 'operation.in_progress', retryable: true,
    subjects: [], detail: null, detailSchemaVersion: 1
  });
  const built = specs.map((spec) => {
    const local = {
      context: ref(`context.speaker-profile.${spec.key}`),
      autonomy: ref(`autonomy.speaker-profile.${spec.key}`),
      family: ref(`speaker-profile.${spec.key}.execution-family`),
      phase: ref(`speaker-profile.${spec.key}.phase.direct-uow`),
      terminal: ref(`speaker-profile.${spec.key}.terminalization`),
      risk: ref(`speaker-profile.${spec.key}.risk`),
      evidence: ref(`speaker-profile.${spec.key}.evidence`),
      approval: ref(`speaker-profile.${spec.key}.approval`),
      preflight: ref(`speaker-profile.${spec.key}.preflight`),
      concurrency: ref(`concurrency.speaker-profile.${spec.key}`),
      projection: ref(`projection.speaker-profile.${spec.key}.operator`)
    };
    const context = createEffectInvocationContextBuilder({
      reference: local.context, operation: spec.operation, effect: 'commit', lanes: [lane],
      scopeResolver, authorityResolver: input.currentAuthority, clock: input.clock,
      newInvocationId: input.ids.newInvocationId,
      authorityPrincipalKeyProfile: input.authorityPrincipalKeyProfile,
      scopePartitionProfile: input.scopePartitionProfile,
      requestCanonicalizationProfile: input.requestCanonicalizationProfile,
      requestHashProfile: SPEAKER_PROFILE_DIRECT_REQUEST_HASH_PROFILE,
      requestHashSealer: input.requestHashSealer,
      idempotencyCredentialProfile: input.idempotencyCredentialProfile,
      idempotencyCredentialSealer: input.idempotencyCredentialSealer,
      deniedAuthorityOutcome: authorityOutcome
    });
    const family = createSingleUnitOfWorkFamilyRegistration({
      reference: local.family, phase: local.phase
    });
    const terminal = createTerminalizationResolverRegistration({
      reference: local.terminal, operation: spec.operation, phase: local.phase,
      resolve: ({ result }) => result.kind === 'success'
        ? { kind: 'terminal' as const } : { kind: 'nonterminal' as const }
    });
    const phase = createSingleUnitOfWorkPhaseRegistration({
      reference: local.phase, family: local.family, operation: spec.operation,
      effect: 'commit', handler: common.handler,
      handlerCapability: SPEAKER_PROFILE_DIRECT_HANDLER_CAPABILITY,
      contributionSchema: common.contribution, terminalization: local.terminal,
      terminalOutcomeKeys: [], contentionOutcome: contention
    });
    const autonomy = createOperationAutonomyPolicy({
      definition: local.autonomy, operation: spec.operation,
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
    const risk = createOperationRiskResolverRegistration({
      reference: local.risk, operation: spec.operation,
      resolve: () => ({
        risk: 'low' as const,
        consequenceTags: Object.freeze([`speaker-profile-${spec.key}`]),
        evidenceIds: Object.freeze([`speaker-profile.${spec.key}.risk`])
      })
    });
    const evidence = createAutonomyEvidenceResolverRegistration({
      reference: local.evidence, operation: spec.operation,
      resolve: ({ subject }) => {
        const bounds = Object.freeze({
          scopeKeys: Object.freeze([...subject.scopeKeys]), maximumSpendMicros: 0,
          maximumActions: 1,
          notAfter: parseInstant(new Date(Date.parse(subject.evaluatedAt) + 60_000).toISOString())
        });
        return Object.freeze({
          evaluatedAt: subject.evaluatedAt, hardBounds: bounds, unattendedBounds: bounds,
          spendMicros: 0, actionCount: 1, completesBy: subject.evaluatedAt,
          proposedAction: Object.freeze({
            key: `speaker-profile.${spec.key}.execute`, version: 1,
            digestSha256: subject.requestHashSha256
          }),
          failure: Object.freeze({ kind: 'none' as const })
        });
      }
    });
    const approval = createRenewedApprovalResolverRegistration({
      reference: local.approval, operation: spec.operation,
      resolve: () => ({ approverCurrentlyAuthorized: false })
    });
    const preflight = createAutonomyPreflightRegistration({
      reference: local.preflight, operation: spec.operation, policy: local.autonomy,
      riskResolver: local.risk, evidenceResolver: local.evidence,
      approvalResolver: local.approval, interventionOutcomes: autonomyInterventionOutcomes(1)
    });
    return { spec, local, context, family, terminal, phase, autonomy, risk, evidence, approval, preflight };
  });
  return Object.freeze({
    id: 'speaker-profile.direct-operations',
    source: Object.freeze({
      contextBuilders: Object.freeze([]), readCapabilities: Object.freeze([]),
      handlers: Object.freeze([]), operations: Object.freeze([]),
      effectExecutionFamilies: Object.freeze(built.map((value) => value.family)),
      effectPhases: Object.freeze(built.map((value) => value.phase)),
      terminalizationResolvers: Object.freeze(built.map((value) => value.terminal)),
      riskResolvers: Object.freeze(built.map((value) => value.risk)),
      autonomyEvidenceResolvers: Object.freeze(built.map((value) => value.evidence)),
      renewedApprovalResolvers: Object.freeze(built.map((value) => value.approval)),
      autonomyPreflights: Object.freeze(built.map((value) => value.preflight)),
      autonomyPolicies: Object.freeze(built.map((value) => value.autonomy)),
      schemas: Object.freeze([
        ...specs.map((spec) => ({ reference: spec.inputRef, schema: spec.input })),
        ...specs.map((spec) => ({ reference: spec.resultRef, schema: spec.result })),
        { reference: common.contribution, schema: speakerProfileDirectContributionSchema },
        { reference: common.canonical, schema: speakerProfileDirectCanonicalResultSchema },
        { reference: common.null, schema: nullSchema },
        { reference: common.changed, schema: speakerProfileChangedDetailSchema }
      ]),
      effectContextBuilders: Object.freeze(built.map((value) => value.context)),
      effectHandlers: Object.freeze([createHandler()]),
      projections: Object.freeze(built.map(({ spec, local }) => ({
        reference: local.projection,
        canonicalResultSchema: common.canonical,
        projectedResultSchema: spec.resultRef,
        project: (candidate: unknown) => speakerProfileDirectCanonicalResultSchema.parse(candidate)
      }))),
      operationAuditTargets: Object.freeze([{
        reference: common.audit, kind: 'operation_audit_record' as const,
        recordProfile: common.auditProfile
      }]),
      operationAuditRecordProfiles: Object.freeze([{
        reference: common.auditProfile, kind: 'canonical_json' as const, maximumBytes: 65_536
      }]),
      effectOperations: Object.freeze(built.map(({ spec, local }) => ({
        ...spec.operation, lifecycle: { status: 'active' as const }, summary: spec.summary,
        effect: 'commit' as const, maxRisk: 'low' as const, autonomyPolicy: local.autonomy,
        consequenceTags: [`speaker-profile-${spec.key}`],
        agentAction: {
          eligible: true as const, displayLabel: spec.displayLabel,
          consequences: [spec.consequence], externalEffect: 'none' as const
        },
        inputSchema: spec.inputRef, contributionSchema: common.contribution,
        canonicalResultSchema: common.canonical,
        outcomes: [
          { class: 'idempotency_conflict' as const, kind: 'operation.request_changed',
            retryable: false, detailSchema: common.null },
          ...access,
          { class: 'conflict' as const, kind: 'speaker.profile.event_required',
            retryable: false, detailSchema: common.null },
          { class: 'stale_revision' as const, kind: 'speaker.profile.changed',
            retryable: false, detailSchema: common.changed },
          { class: 'conflict' as const, kind: 'operation.in_progress',
            retryable: true, detailSchema: common.null },
          ...autonomyInterventionOutcomeDeclarations(common.null)
        ],
        accessLanes: [lane], contextBuilder: local.context,
        handlerCapability: SPEAKER_PROFILE_DIRECT_HANDLER_CAPABILITY, handler: common.handler,
        audit: { mode: 'required' as const, target: common.audit },
        idempotency: {
          keySource: common.keySource,
          credentialVerifierProfile: input.idempotencyCredentialProfile,
          requestHashProfile: SPEAKER_PROFILE_DIRECT_REQUEST_HASH_PROFILE
        },
        concurrency: local.concurrency,
        execution: {
          kind: 'single_unit_of_work' as const, profile: 'direct_audited' as const,
          family: local.family, phase: local.phase, terminalization: local.terminal,
          autonomyPreflight: local.preflight, history: { summary: spec.history }
        },
        bindings: [{
          surface: 'operator_http' as const, method: 'POST' as const, path: spec.path,
          input: 'body' as const, browserResumption: { kind: 'none' as const },
          projection: local.projection
        }]
      })))
    })
  });
}
