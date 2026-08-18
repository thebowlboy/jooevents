import { describe, expect, test } from 'bun:test';
import {
  createEffectfulOperationResultSchema,
  structuredOutcomeSchema,
  type EffectfulOperationResult,
  type SafeSchemaManifestRef,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import {
  parseOperationAccessLane,
  type VersionedKeyProfileRef
} from '@jooevents/identity-access';
import {
  canonicalJsonText,
  parseContractVersion,
  parseAuthorityCitationId,
  parseCapabilityRevisionId,
  parseInstant,
  parseInvocationId,
  parseJobId,
  parseMembershipId,
  parseUserId,
  parseWorkspaceId
} from '@jooevents/kernel';
import { z } from 'zod';
import { createOperationAutonomyPolicy } from '../autonomy';
import {
  createPublicEffectConformanceBoundary,
  type PublicEffectConformanceBoundary
} from '../public-effect-conformance';
import {
  assertApplicationOperationRuntime,
  createApplicationOperationRuntime
} from './runtime';
import {
  createContextDeniedOperationAuditRecord,
  createIdempotencyConflictOperationAuditRecord,
  createNonterminalProgressOperationAuditRecord,
  createTerminalNewOperationAuditRecord,
  createTerminalReplayOperationAuditRecord,
  isSealedOperationAuditRecord
} from './audit';
import {
  assertTerminalEffectReceiptIssuedForInvocation,
  createEffectInvocationBuilder,
  createEffectOperationExecutor,
  resolveEffectAutonomyExecutionEvidence
} from './effect-executor';
import { createDirectOperationFeatureContributorRegistry } from './direct-feature-contributors';
import { OperationExecutionError, OperationInputError } from './executor';
import { createSingleUnitOfWorkConformanceFixture } from './phase-autonomy-fixture';
import {
  createAutonomyEvidenceResolverRegistration,
  createAutonomyPreflightRegistration,
  createRenewedApprovalResolverRegistration
} from './autonomy-preflight';
import {
  createSingleUnitOfWorkPhaseRegistration,
  createTerminalizationResolverRegistration
} from './phase-contract';
import {
  createEffectInvocationContextBuilder,
  createHmacRequestHashSealer,
  isSealedInvocationContext,
  recheckEffectInvocationCurrentAuthority,
  type SealedEffectAuthorityRecheckResult
} from './invocation-context';
import {
  createOperationRegistry,
  createReadOperationRegistry,
  getCompiledEffectOperation,
  getCompiledRegisteredConsumerEffectOperation,
  getCompiledRegisteredJobEffectOperation,
  OperationRegistryValidationError
} from './registry';
import type {
  DirectAuditedUnitOfWork,
  DirectOperationFeatureContribution,
  DirectOperationFeatureContributor,
  DirectOperationLogRecord,
  EffectOperationIdentity,
  EffectHandlerRegistration,
  EffectHandlerSnapshot,
  EffectInvocationContext,
  EffectUnitOfWork,
  EffectUnitOfWorkPort,
  OperationAuditRecord,
  OperationRegistry,
  OperationRegistrySource,
  ReadProjectionRegistration,
  RegisteredOperationSchema,
  ShortOperationAuditRecord,
  TerminalEffectReceipt
} from './types';

const correlationIds = [
  '018f0f47-7a86-7d36-8a25-9f86589c7a4d',
  '018f0f47-7a86-7d36-8a25-9f86589c7a4e',
  '018f0f47-7a86-7d36-8a25-9f86589c7a4f'
] as const;

const receiptIds = [
  '018f0f47-7a86-7d36-8a25-9f86589c7b40',
  '018f0f47-7a86-7d36-8a25-9f86589c7b41',
  '018f0f47-7a86-7d36-8a25-9f86589c7b42'
] as const;

const authorityIds = {
  workspaceAlpha: parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000'),
  workspaceBeta: parseWorkspaceId('550e8400-e29b-41d4-a716-446655440001'),
  ada: parseUserId('01890f47-9abc-7def-8123-456789abc001'),
  grace: parseUserId('01890f47-9abc-7def-8123-456789abc002'),
  adaMembership: parseMembershipId('01890f47-9abc-7def-8123-456789abc003'),
  graceMembership: parseMembershipId('01890f47-9abc-7def-8123-456789abc004'),
  invocation: parseInvocationId('01890f47-9abc-7def-8123-456789abc005')
} as const;
const authorityInstant = parseInstant('2026-08-11T00:00:00.000Z');
const keyProfile = { key: 'effect-operation-test', version: parseContractVersion(1) } as const;
const rotatedKeyProfile = { key: 'effect-operation-test', version: parseContractVersion(2) } as const;
const operatorLane = parseOperationAccessLane({
  kind: 'operator',
  surface: 'operator_http',
  policy: { key: 'authority.effect-operation-test', version: 1 }
});
const registeredConsumerLane = parseOperationAccessLane({
  kind: 'registered_consumer',
  surface: 'application_job',
  policy: { key: 'authority.registered-consumer-effect-test', version: 1 }
});
const registeredJobLane = parseOperationAccessLane({
  kind: 'registered_job',
  surface: 'application_job',
  policy: { key: 'authority.registered-job-effect-test', version: 1 }
});
const appModelLane = parseOperationAccessLane({
  kind: 'app_model',
  surface: 'app_model',
  policy: { key: 'authority.app-model-effect-test', version: 1 }
});
const publicCeremonyLane = parseOperationAccessLane({
  kind: 'public_ceremony',
  surface: 'public_http',
  policy: { key: 'authority.public-ceremony-effect-test', version: 1 }
});

function definitionRef(key: string): VersionedDefinitionRef {
  return { key, version: 1 };
}

function schemaRef(key: string, seed: string): SafeSchemaManifestRef {
  return { key, version: 1, digestSha256: seed.repeat(64) };
}

const refs = {
  input: schemaRef('schema.note-effect.input', '1'),
  contribution: schemaRef('schema.note-effect.contribution', '2'),
  canonical: schemaRef('schema.note-effect.canonical', '3'),
  projected: schemaRef('schema.note-effect.operator-result', '4'),
  conflictDetail: schemaRef('schema.operation.request-changed-detail', '5'),
  context: definitionRef('context.note-effect'),
  autonomy: definitionRef('autonomy.note-effect'),
  capability: definitionRef('capability.note-effect-write'),
  handler: definitionRef('handler.note-effect'),
  projection: definitionRef('projection.note-effect-operator'),
  consumer: definitionRef('consumer.note-effect-projection'),
  job: definitionRef('job.note-effect-commit'),
  jobInputProjection: definitionRef('input-projection.note-effect-job'),
  jobCapabilityRevisionId: parseCapabilityRevisionId('01890f47-9abc-7def-8123-456789abc006'),
  jobAuthorityCitation: definitionRef('authority-citation.note-effect-job'),
  jobAuthorityCitationId: parseAuthorityCitationId('01890f47-9abc-7def-8123-456789abc007'),
  jobId: parseJobId('01890f47-9abc-7def-8123-456789abc008'),
  keySource: definitionRef('idempotency.operator-header'),
  requestHash: definitionRef('request-hash.canonical-input'),
  concurrency: definitionRef('concurrency.ordinary-effect'),
  audit: definitionRef('audit.note-effect'),
  auditRecordProfile: definitionRef('audit-record.canonical-json')
} as const;

const inputSchema = z.strictObject({
  value: z.string().min(1),
  mode: z.enum(['success', 'crash', 'forge', 'reserved-audit', 'nonterminal']).default('success'),
  workspace: z.enum(['workspace-alpha', 'workspace-beta']).default('workspace-alpha')
});

const canonicalSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: z.strictObject({
    value: z.string(), action: z.string().optional()
  }) }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);

const contributionSchema = z.strictObject({
  result: canonicalSchema,
  domain: z.union([z.strictObject({ value: z.string() }), z.null()]),
  effectContributions: z.array(z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('domain_evidence'), safeValue: z.string() }),
    z.strictObject({ kind: z.literal('operation_audit'), safeValue: z.string() })
  ]))
});

const projectedSchema = createEffectfulOperationResultSchema(z.strictObject({ value: z.string() }));

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

interface FixtureTracker {
  readonly rawKeysSeen: string[];
  handlerCalls: number;
  projectionCalls: number;
  readonly handlerSnapshotKeys: string[][];
  readonly handlerContexts: EffectInvocationContext[];
  authorityCalls: number;
}

function fixture(options: {
  readonly effect?: 'draft' | 'commit';
  readonly handlerEffect?: 'draft' | 'commit';
  readonly asyncProjection?: boolean;
  readonly nondeterministicProjection?: boolean;
  readonly semanticRewriteProjection?: boolean;
  readonly tracker?: FixtureTracker;
  readonly builderCredentialProfile?: VersionedKeyProfileRef;
  readonly operationCredentialProfile?: VersionedDefinitionRef;
  readonly builderRequestHashProfile?: VersionedDefinitionRef;
  readonly operationRequestHashProfile?: VersionedDefinitionRef;
  readonly registeredConsumer?: boolean;
  readonly registeredJob?: boolean;
  readonly operatorBinding?: boolean;
  readonly publicBinding?: boolean;
  readonly publicEffectConformance?: PublicEffectConformanceBoundary;
  readonly appModelBinding?: boolean;
  readonly denyAuthority?: boolean;
  readonly directAudited?: boolean;
  readonly directAction?: string;
  readonly directSummariesByAction?: Readonly<Record<string, string>>;
} = {}): OperationRegistrySource {
  const effect = options.effect ?? 'draft';
  const tracker = options.tracker;
  let projectionSequence = 0;
  const operationName = effect === 'draft' ? 'note.draft' : 'note.commit';
  const autonomyPolicy = createOperationAutonomyPolicy({
    definition: refs.autonomy,
    operation: { name: operationName, version: 1 },
    riskFloor: options.directAudited ? 'low' : effect === 'draft' ? 'normal' : 'consequential',
    unattendedRiskCeiling: options.directAudited
      ? 'low'
      : effect === 'draft' ? 'normal' : 'consequential',
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
    requiresSeparateApproval: effect === 'commit' && !options.directAudited
  });
  const accessLanes = [
    ...(options.operatorBinding === false ? [] : [operatorLane]),
    ...(options.registeredConsumer ? [registeredConsumerLane] : []),
    ...(options.registeredJob ? [registeredJobLane] : []),
    ...(options.appModelBinding ? [appModelLane] : []),
    ...(options.publicBinding ? [publicCeremonyLane] : [])
  ];
  const contextBuilder = (options.publicEffectConformance?.createContextBuilder
    ?? createEffectInvocationContextBuilder)({
    reference: refs.context,
    operation: { name: operationName, version: 1 },
    effect,
    lanes: accessLanes,
    scopeResolver: {
      resolve: ({ evidence, businessInput }) => {
        if (evidence.kind === 'registered_job') {
          return {
            workspaceId: authorityIds.workspaceAlpha,
            subjects: [{ kind: 'workspace' as const, id: authorityIds.workspaceAlpha }],
            resolutionEvidenceIds: [`job:${evidence.jobId}`]
          };
        }
        if (evidence.kind === 'app_model') {
          return {
            workspaceId: authorityIds.workspaceAlpha,
            subjects: [{ kind: 'workspace' as const, id: authorityIds.workspaceAlpha }],
            resolutionEvidenceIds: [`model-tool:${evidence.modelToolCallId}`]
          };
        }
        if (evidence.kind !== 'operator') throw new TypeError('operator or app-model evidence required');
        const workspaceId = inputSchema.parse(businessInput).workspace === 'workspace-beta'
          ? authorityIds.workspaceBeta
          : authorityIds.workspaceAlpha;
        return {
          workspaceId,
          subjects: [{ kind: 'workspace', id: workspaceId }],
          resolutionEvidenceIds: ['workspace-target:v1']
        };
      }
    },
    authorityResolver: {
      resolve: (input) => {
        if (tracker) tracker.authorityCalls += 1;
        if (options.denyAuthority) return { kind: 'denied' as const, reason: 'not_authorized' as const };
        if (input.evidence.kind === 'registered_job') {
          return {
            kind: 'authorized' as const,
            authority: {
              actor: {
                kind: 'system_job' as const,
                jobId: input.evidence.jobId,
                registeredCapabilityRevisionId: refs.jobCapabilityRevisionId
              },
              principal: {
                kind: 'registered_job' as const,
                jobId: input.evidence.jobId,
                capabilityRevisionId: refs.jobCapabilityRevisionId,
                authorityCitationId: refs.jobAuthorityCitationId
              },
              lane: input.lane,
              scope: input.scope,
              grants: [{ kind: 'registered_capability' as const, key: refs.jobCapabilityRevisionId }],
              evidenceIds: [`job-current:${input.evidence.jobId}`],
              authorityCitationIds: [refs.jobAuthorityCitationId],
              evaluatedAt: input.evaluatedAt
            }
          };
        }
        if (input.evidence.kind === 'app_model') {
          return {
            kind: 'authorized' as const,
            authority: {
              actor: {
                kind: 'app_model_run' as const,
                agentRunId: input.evidence.agentRunId,
                delegatedByPrincipalId: `workspace-user:${authorityIds.ada}`
              },
              principal: {
                kind: 'workspace_user' as const,
                userId: authorityIds.ada,
                membershipId: authorityIds.adaMembership
              },
              lane: input.lane,
              scope: input.scope,
              grants: [{ kind: 'permission' as const, key: 'test.note.write' }],
              evidenceIds: [`model-tool-current:${input.evidence.modelToolCallId}`],
              authorityCitationIds: [],
              evaluatedAt: input.evaluatedAt
            }
          };
        }
        if (input.evidence.kind !== 'operator') return { kind: 'denied', reason: 'lane_mismatch' };
        const isGrace = input.evidence.sessionHandle.startsWith('grace:');
        const userId = isGrace ? authorityIds.grace : authorityIds.ada;
        const membershipId = isGrace ? authorityIds.graceMembership : authorityIds.adaMembership;
        return {
          kind: 'authorized',
          authority: {
            actor: { kind: 'workspace_user', userId },
            principal: { kind: 'workspace_user', userId, membershipId },
            lane: input.lane,
            scope: input.scope,
            grants: [{ kind: 'permission', key: 'test.note.write' }],
            evidenceIds: ['membership-current:v1'],
            authorityCitationIds: [],
            evaluatedAt: input.evaluatedAt
          }
        };
      }
    },
    clock: { now: () => authorityInstant },
    newInvocationId: () => parseInvocationId(crypto.randomUUID()),
    authorityPrincipalKeyProfile: keyProfile,
    scopePartitionProfile: keyProfile,
    requestCanonicalizationProfile: keyProfile,
    requestHashProfile: options.builderRequestHashProfile ?? refs.requestHash,
    requestHashSealer: createHmacRequestHashSealer({
      profile: options.builderRequestHashProfile ?? refs.requestHash,
      keyBytes: new Uint8Array(32).fill(0x31)
    }),
    idempotencyCredentialProfile: options.builderCredentialProfile ?? keyProfile,
    deniedAuthorityOutcome: () => ({
      class: 'access_denied',
      kind: 'authority.denied',
      retryable: false,
      subjects: [],
      detail: null,
      detailSchemaVersion: 1
    }),
    idempotencyCredentialSealer: {
      async seal(rawIdempotencyKey) {
        tracker?.rawKeysSeen.push(rawIdempotencyKey);
        return {
          verifierProfile: options.builderCredentialProfile ?? keyProfile,
          verifierSha256: await sha256(`key:v1:${rawIdempotencyKey}`)
        };
      }
    }
  });
  const phaseControl = createSingleUnitOfWorkConformanceFixture({
    operation: { name: operationName, version: 1, effect },
    maximumRisk: options.directAudited ? 'low' : effect === 'draft' ? 'normal' : 'consequential',
    consequenceTags: options.directAudited ? [] : effect === 'draft' ? [] : ['authority-changing'],
    autonomyPolicy,
    handler: refs.handler,
    handlerCapability: refs.capability,
    contributionSchema: refs.contribution,
    nullDetailSchema: refs.conflictDetail
  });
  return {
    ...phaseControl.registrations,
    autonomyPolicies: [autonomyPolicy],
    schemas: [
      { reference: refs.input, schema: inputSchema },
      { reference: refs.contribution, schema: contributionSchema },
      { reference: refs.canonical, schema: canonicalSchema },
      { reference: refs.projected, schema: projectedSchema },
      { reference: refs.conflictDetail, schema: z.null() }
    ],
    contextBuilders: [],
    readCapabilities: [],
    handlers: [],
    projections: [{
      reference: refs.projection,
      canonicalResultSchema: refs.canonical,
      projectedResultSchema: refs.projected,
      project: (candidate) => {
        tracker && (tracker.projectionCalls += 1);
        if (options.asyncProjection) return Promise.resolve(candidate);
        const parsed = canonicalSchema.parse(candidate);
        if (options.nondeterministicProjection && parsed.kind === 'success') {
          projectionSequence += 1;
          return { kind: 'success' as const, data: { value: `${parsed.data.value}:${projectionSequence}` } };
        }
        if (options.semanticRewriteProjection && parsed.kind === 'success') {
          return {
            kind: 'outcome' as const,
            outcome: {
              class: 'access_denied' as const,
              kind: 'authority.denied',
              retryable: false,
              subjects: [],
              detail: null,
              detailSchemaVersion: refs.conflictDetail.version
            }
          };
        }
        return parsed.kind === 'success'
          ? { kind: 'success' as const, data: { value: parsed.data.value } }
          : parsed;
      }
    }],
    operations: [],
    effectContextBuilders: [contextBuilder],
    operationAuditTargets: [{
      reference: refs.audit,
      kind: 'operation_audit_record',
      recordProfile: refs.auditRecordProfile
    }],
    operationAuditRecordProfiles: [{
      reference: refs.auditRecordProfile,
      kind: 'canonical_json',
      maximumBytes: 65_536
    }],
    effectHandlers: [{
      reference: refs.handler,
      effect: options.handlerEffect ?? effect,
      handlerCapability: refs.capability,
      contributionSchema: refs.contribution,
      canonicalResultSchema: refs.canonical,
      handle: ({ businessInput, context, snapshot }) => {
        tracker && (tracker.handlerCalls += 1);
        tracker?.handlerSnapshotKeys.push(Object.keys(snapshot));
        expect(Object.isFrozen(context)).toBe(true);
        expect(isSealedInvocationContext(context)).toBe(true);
        tracker?.handlerContexts.push(context);
        expect(Object.isFrozen(snapshot)).toBe(true);
        const request = inputSchema.parse(businessInput);
        if (request.mode === 'crash') throw new Error('handler-private-crash');
        if (request.mode === 'nonterminal') {
          return {
            result: {
              kind: 'outcome' as const,
              outcome: {
                class: 'access_denied' as const,
                kind: 'authority.denied',
                retryable: false,
                subjects: [],
                detail: null,
                detailSchemaVersion: refs.conflictDetail.version
              }
            },
            domain: null,
            effectContributions: []
          };
        }
        const ordinary = {
          result: { kind: 'success' as const, data: {
            value: request.value,
            ...(options.directAction ? { action: options.directAction } : {})
          } },
          domain: { value: request.value },
          effectContributions: options.directAudited
            ? []
            : request.mode === 'reserved-audit'
            ? [{ kind: 'operation_audit' as const, safeValue: request.value }]
            : [{ kind: 'domain_evidence' as const, safeValue: request.value }]
        };
        return request.mode === 'forge'
          ? { ...ordinary, receipt: { id: receiptIds[0] }, correlationId: correlationIds[0] }
          : ordinary;
      }
    }],
    effectOperations: [{
      name: operationName,
      version: 1,
      lifecycle: { status: 'active' },
      summary: effect === 'draft' ? 'Create an inert note draft.' : 'Commit a note.',
      effect,
      maxRisk: options.directAudited ? 'low' : effect === 'draft' ? 'normal' : 'consequential',
      autonomyPolicy: refs.autonomy,
      consequenceTags: options.directAudited ? [] : effect === 'draft' ? [] : ['authority-changing'],
      inputSchema: refs.input,
      contributionSchema: refs.contribution,
      canonicalResultSchema: refs.canonical,
      outcomes: [{
        class: 'idempotency_conflict',
        kind: 'operation.request_changed',
        retryable: false,
        detailSchema: refs.conflictDetail
      }, {
        class: 'access_denied',
        kind: 'authority.denied',
        retryable: false,
        detailSchema: refs.conflictDetail
      }, phaseControl.contentionOutcomeDeclaration, ...phaseControl.outcomeDeclarations],
      accessLanes,
      contextBuilder: refs.context,
      handlerCapability: refs.capability,
      handler: refs.handler,
      audit: { mode: 'required', target: refs.audit },
      idempotency: {
        keySource: refs.keySource,
        credentialVerifierProfile: options.operationCredentialProfile ?? keyProfile,
        requestHashProfile: options.operationRequestHashProfile ?? refs.requestHash
      },
      concurrency: refs.concurrency,
      execution: options.directAudited
        ? {
            ...phaseControl.execution,
            profile: 'direct_audited' as const,
            history: options.directSummariesByAction
              ? { summariesByAction: options.directSummariesByAction }
              : { summary: 'Committed synthetic note' }
          }
        : phaseControl.execution,
      bindings: [
        ...(options.operatorBinding === false ? [] : [{
          surface: 'operator_http' as const,
          method: 'POST' as const,
          path: effect === 'draft' ? '/api/test/note-drafts' : '/api/test/note-commits',
          input: 'body' as const,
          browserResumption: { kind: 'none' as const },
          projection: refs.projection
        }]),
        ...(options.appModelBinding ? [{
          surface: 'app_model' as const,
          toolName: effect === 'draft' ? 'note_draft' : 'note_commit',
          projection: refs.projection
        }] : []),
        ...(options.publicBinding ? [{
          surface: 'public_http' as const,
          method: 'POST' as const,
          path: effect === 'draft' ? '/api/public/test/note-drafts' : '/api/public/test/note-commits',
          input: 'body' as const,
          browserResumption: {
            kind: 'server_ref' as const,
            referenceSchema: refs.input,
            requestCodec: definitionRef('codec.public-note-effect-request'),
            maximumReferenceBytes: 256
          },
          projection: refs.projection
        }] : [])
      ],
      registeredConsumerBindings: options.registeredConsumer ? [{
        surface: 'application_job',
        lane: 'registered_consumer',
        consumer: refs.consumer,
        projection: refs.projection
      }] : [],
      registeredJobBindings: options.registeredJob ? [{
        surface: 'application_job',
        lane: 'registered_job',
        job: refs.job,
        inputProjection: refs.jobInputProjection,
        capabilityRevisionId: refs.jobCapabilityRevisionId,
        authorityCitation: refs.jobAuthorityCitation,
        projection: refs.projection
      }] : []
    }]
  };
}

function identityKey(identity: EffectOperationIdentity): string {
  return [
    identity.scopePartitionKey,
    identity.authorityPrincipalKey,
    identity.operationName,
    identity.operationVersion,
    identity.surface,
    `${identity.idempotencyVerifierProfile.key}@${identity.idempotencyVerifierProfile.version}`,
    identity.idempotencyKeyVerifier
  ].join('|');
}

type FailurePoint = 'snapshot' | 'domain' | 'parent' | 'child' | 'release' | 'commit';

interface MemoryState {
  readonly receipts: Map<string, TerminalEffectReceipt>;
  readonly directLogs: Map<string, DirectOperationLogRecord>;
  readonly domain: unknown[];
  readonly children: { readonly receiptId: string; readonly contribution: unknown }[];
  readonly featureContributions: DirectOperationFeatureContribution[];
  readonly audits: Map<string, OperationAuditRecord>;
}

function cloneState(state: MemoryState): MemoryState {
  return {
    receipts: new Map(state.receipts),
    directLogs: new Map(state.directLogs),
    domain: [...state.domain],
    children: [...state.children],
    featureContributions: [...state.featureContributions],
    audits: new Map(state.audits)
  };
}

class InMemoryEffectUnitOfWork implements EffectUnitOfWorkPort {
  readonly trace: string[] = [];
  readonly failure: FailurePoint | undefined;
  private state: MemoryState = {
    receipts: new Map(), directLogs: new Map(), domain: [], children: [], featureContributions: [],
    audits: new Map()
  };
  commits = 0;
  receiptObserver?: (receipt: TerminalEffectReceipt) => void;
  authorityRecheckOverride?: (
    context: EffectInvocationContext
  ) => Promise<SealedEffectAuthorityRecheckResult> | SealedEffectAuthorityRecheckResult;
  handlerSnapshot: unknown = { currentValue: null };
  receiptOverride?: TerminalEffectReceipt;

  constructor(failure?: FailurePoint) {
    this.failure = failure;
  }

  get receiptCount() { return this.state.receipts.size; }
  get directLogCount() { return this.state.directLogs.size; }
  get directLogSummaries() { return [...this.state.directLogs.values()].map((record) => record.summary); }
  get domainCount() { return this.state.domain.length; }
  get childCount() { return this.state.children.length; }
  get storedReceipts() { return [...this.state.receipts.values()]; }
  get storedChildren() { return [...this.state.children]; }
  get storedFeatureContributions() { return [...this.state.featureContributions]; }
  get storedAudits() { return [...this.state.audits.values()]; }

  private fail(point: FailurePoint) {
    if (this.failure === point) throw new Error(`crash:${point}`);
  }

  findTerminalReceipt(identity: EffectOperationIdentity): TerminalEffectReceipt | undefined {
    this.trace.push('replay_preflight');
    return this.receiptOverride ?? this.state.receipts.get(identityKey(identity));
  }

  findTerminalOperationLog(identity: EffectOperationIdentity): TerminalEffectReceipt | undefined {
    this.trace.push('direct_log_preflight');
    return this.state.directLogs.get(identityKey(identity))?.receipt;
  }

  recordShortOperationAudit(record: ShortOperationAuditRecord): void {
    this.trace.push('short_audit');
    if (!isSealedOperationAuditRecord(record)) throw new Error('unsealed audit');
    const existing = this.state.audits.get(record.eventId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(record)) throw new Error('audit identity conflict');
    if (!existing) this.state.audits.set(record.eventId, record);
  }

  async runInUnitOfWork<Value>(work: (unitOfWork: EffectUnitOfWork) => Promise<Value>): Promise<Value> {
    this.trace.push('begin');
    const working = cloneState(this.state);
    const fail = (point: FailurePoint) => this.fail(point);
    const trace = this.trace;
    const receiptObserver = this.receiptObserver;
    const authorityRecheckOverride = this.authorityRecheckOverride;
    const handlerSnapshot = this.handlerSnapshot;
    const receiptOverride = this.receiptOverride;
    const unitOfWork: EffectUnitOfWork = {
      recheckCurrentAuthority(context) {
        trace.push('authority_recheck');
        return authorityRecheckOverride?.(context)
          ?? recheckEffectInvocationCurrentAuthority(context);
      },
      findTerminalReceipt(identity) {
        trace.push('replay_recheck');
        return receiptOverride ?? working.receipts.get(identityKey(identity));
      },
      openHandlerSnapshot(capability) {
        trace.push('snapshot');
        expect(capability).toEqual(refs.capability);
        fail('snapshot');
        return handlerSnapshot as EffectHandlerSnapshot;
      },
      applyDomainContribution(capability, contribution) {
        trace.push('domain');
        expect(capability).toEqual(refs.capability);
        working.domain.push(structuredClone(contribution));
        fail('domain');
      },
      insertOperationLog(record) {
        trace.push('operation_log');
        receiptObserver?.(record.receipt);
        const key = identityKey(record.receipt.identity);
        if (working.receipts.has(key)) throw new Error('duplicate receipt');
        working.receipts.set(key, record.receipt);
        working.directLogs.set(key, record);
        fail('parent');
      },
      applyEffectContribution(receiptId, contribution) {
        trace.push('effect_contribution');
        working.children.push({ receiptId, contribution: structuredClone(contribution) });
        fail('child');
      },
      finishEffectApplication() {
        trace.push('release');
        fail('release');
      }
    };

    try {
      const result = await work(unitOfWork);
      this.fail('commit');
      this.state = working;
      this.commits += 1;
      this.trace.push('commit');
      return result;
    } catch (error) {
      this.trace.push('rollback');
      throw error;
    }
  }

  async runInDirectUnitOfWork<Value>(
    work: (unitOfWork: DirectAuditedUnitOfWork) => Promise<Value>
  ): Promise<Value> {
    this.trace.push('direct_begin');
    const working = cloneState(this.state);
    const trace = this.trace;
    const handlerSnapshot = this.handlerSnapshot;
    const authorityRecheckOverride = this.authorityRecheckOverride;
    const unitOfWork: DirectAuditedUnitOfWork = {
      recheckCurrentAuthority(context) {
        trace.push('authority_recheck');
        return authorityRecheckOverride?.(context)
          ?? recheckEffectInvocationCurrentAuthority(context);
      },
      findTerminalOperationLog(identity) {
        trace.push('direct_log_recheck');
        return working.directLogs.get(identityKey(identity))?.receipt;
      },
      openHandlerSnapshot(capability) {
        trace.push('snapshot');
        expect(capability).toEqual(refs.capability);
        return handlerSnapshot as EffectHandlerSnapshot;
      },
      applyDomainContribution(capability, contribution) {
        trace.push('domain');
        expect(capability).toEqual(refs.capability);
        working.domain.push(structuredClone(contribution));
      },
      insertOperationLog(record: DirectOperationLogRecord) {
        trace.push('direct_log');
        const key = identityKey(record.receipt.identity);
        if (working.directLogs.has(key)) throw new Error('duplicate direct log');
        working.directLogs.set(key, record);
      },
      applyFeatureContribution(contribution) {
        trace.push('feature_contribution');
        working.featureContributions.push(structuredClone(contribution));
      }
    };
    try {
      const result = await work(unitOfWork);
      this.fail('commit');
      this.state = working;
      this.commits += 1;
      this.trace.push('direct_commit');
      return result;
    } catch (error) {
      this.trace.push('direct_rollback');
      throw error;
    }
  }
}

function tracker(): FixtureTracker {
  return {
    rawKeysSeen: [],
    handlerCalls: 0,
    projectionCalls: 0,
    handlerSnapshotKeys: [],
    handlerContexts: [],
    authorityCalls: 0
  };
}

async function harness(options: {
  readonly effect?: 'draft' | 'commit';
  readonly handlerEffect?: 'draft' | 'commit';
  readonly failure?: FailurePoint;
  readonly asyncProjection?: boolean;
  readonly nondeterministicProjection?: boolean;
  readonly semanticRewriteProjection?: boolean;
  readonly directAudited?: boolean;
  readonly directAction?: string;
  readonly directSummariesByAction?: Readonly<Record<string, string>>;
  readonly directFeatureContributor?: DirectOperationFeatureContributor;
  readonly directFeatureContributors?: readonly DirectOperationFeatureContributor[];
} = {}) {
  const observed = tracker();
  const registry = await createOperationRegistry(fixture({
    tracker: observed,
    ...(options.effect ? { effect: options.effect } : {}),
    ...(options.handlerEffect ? { handlerEffect: options.handlerEffect } : {}),
    ...(options.asyncProjection !== undefined ? { asyncProjection: options.asyncProjection } : {}),
    ...(options.nondeterministicProjection !== undefined
      ? { nondeterministicProjection: options.nondeterministicProjection }
      : {}),
    ...(options.semanticRewriteProjection !== undefined
      ? { semanticRewriteProjection: options.semanticRewriteProjection }
      : {}),
    ...(options.directAudited !== undefined ? { directAudited: options.directAudited } : {}),
    ...(options.directAction !== undefined ? { directAction: options.directAction } : {}),
    ...(options.directSummariesByAction !== undefined
      ? { directSummariesByAction: options.directSummariesByAction }
      : {})
  }));
  const port = new InMemoryEffectUnitOfWork(options.failure);
  let nextReceipt = 0;
  return {
    registry,
    observed,
    port,
    builder: createEffectInvocationBuilder(registry),
    executor: createEffectOperationExecutor({
      registry,
      unitOfWork: port,
      ...(options.directFeatureContributor
        ? { directFeatureContributor: options.directFeatureContributor }
        : {}),
      ...(options.directFeatureContributors
        ? {
            directFeatureContributors: createDirectOperationFeatureContributorRegistry(
              options.directFeatureContributors
            )
          }
        : {}),
      newOperationLogId: () => receiptIds[nextReceipt++] ?? crypto.randomUUID()
    })
  };
}

async function sealed(input: {
  readonly builder: Awaited<ReturnType<typeof harness>>['builder'];
  readonly effect?: 'draft' | 'commit';
  readonly principal?: string;
  readonly scope?: string;
  readonly rawKey?: string;
  readonly value?: string;
  readonly mode?: 'success' | 'crash' | 'forge' | 'reserved-audit' | 'nonterminal';
  readonly correlationId?: string;
}) {
  const effect = input.effect ?? 'draft';
  return input.builder.build({
    operationName: effect === 'draft' ? 'note.draft' : 'note.commit',
    operationVersion: 1,
    surface: 'operator_http',
    correlationId: input.correlationId ?? correlationIds[0],
    businessInput: {
      value: input.value ?? 'alpha',
      mode: input.mode ?? 'success',
      workspace: input.scope ?? 'workspace-alpha'
    },
    verifiedEvidence: {
      kind: 'operator',
      surface: 'operator_http',
      client: { key: 'web.test' },
      sessionHandle: `${input.principal ?? 'ada'}:${input.scope ?? 'workspace-alpha'}`
    },
    rawIdempotencyKey: input.rawKey ?? 'raw-secret-key'
  });
}

describe('ordinary effect definition compatibility', () => {
  test('publishes only an exact app-model draft tool binding and discards it from a read-only registry', async () => {
    const source = fixture({ appModelBinding: true, operatorBinding: false });
    const registry = await createOperationRegistry(source);
    expect(registry.appModelEffectBindings).toEqual([{
      operationName: 'note.draft',
      operationVersion: 1,
      surface: 'app_model',
      toolName: 'note_draft'
    }]);
    expect(getCompiledEffectOperation(registry, 'note.draft', 1, 'app_model')?.binding)
      .toMatchObject({ surface: 'app_model', toolName: 'note_draft' });
    expect(registry.safeManifest.operations[0]?.enabledBindings).toEqual([expect.objectContaining({
      surface: 'app_model',
      protocol: 'tool',
      toolName: 'note_draft'
    })]);
    const readOnly = await createReadOperationRegistry(source);
    expect(Object.hasOwn(readOnly, 'appModelEffectBindings')).toBe(false);
    expect(getCompiledEffectOperation(readOnly as OperationRegistry, 'note.draft', 1, 'app_model')).toBeUndefined();
  });

  test('rejects app-model commit activation and a binding without the exact app-model lane', async () => {
    await expect(createOperationRegistry(fixture({
      effect: 'commit',
      handlerEffect: 'commit',
      appModelBinding: true,
      operatorBinding: false
    }))).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ code: 'app_model_commit_forbidden' })])
    });

    const source = fixture({ appModelBinding: true, operatorBinding: false });
    const substituted: OperationRegistrySource = {
      ...source,
      effectOperations: (source.effectOperations ?? []).map((operation) => ({
        ...operation,
        accessLanes: []
      }))
    };
    await expect(createOperationRegistry(substituted)).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ code: 'app_model_lane_mismatch' })])
    });
  });

  test('the read-only registry runtime discards excess effect source fields', async () => {
    const effectSource = fixture({
      effect: 'draft',
      handlerEffect: 'draft',
      registeredConsumer: true
    });
    const readRegistry = await createReadOperationRegistry(effectSource);
    expect(Object.hasOwn(readRegistry, 'operatorHttpEffectBindings')).toBe(false);
    expect(readRegistry.safeManifest.operations).toEqual([]);
    expect(getCompiledEffectOperation(
      readRegistry as OperationRegistry,
      'note.draft',
      1,
      'operator_http'
    )).toBeUndefined();
    expect(getCompiledRegisteredConsumerEffectOperation(
      readRegistry as OperationRegistry,
      refs.consumer.key,
      refs.consumer.version
    )).toBeUndefined();
  });

  test('seals exact registered-consumer bindings without manifest or operator leakage', async () => {
    const registry = await createOperationRegistry(fixture({ registeredConsumer: true }));
    const resolved = getCompiledRegisteredConsumerEffectOperation(
      registry,
      refs.consumer.key,
      refs.consumer.version
    );
    expect(resolved?.operation.definition.name).toBe('note.draft');
    expect(resolved?.operation.definition.version).toBe(1);
    expect(resolved?.binding.surface).toBe('application_job');
    expect(resolved?.binding.lane).toBe('registered_consumer');
    expect(resolved?.binding.projectedResultSchema.reference).toEqual(refs.projected);
    expect(Object.isFrozen(resolved?.binding)).toBe(true);
    expect(Object.isFrozen(resolved?.binding.consumer)).toBe(true);
    expect(registry.operatorHttpEffectBindings).toHaveLength(1);
    const safe = JSON.stringify(registry.safeManifest);
    expect(safe).not.toContain(refs.consumer.key);
    expect(safe).not.toContain('registered_consumer');
    expect(safe).not.toContain('application_job');

    const internalOnly = await createOperationRegistry(fixture({
      registeredConsumer: true,
      operatorBinding: false
    }));
    expect(internalOnly.safeManifest.operations).toEqual([]);
    expect(internalOnly.operatorHttpEffectBindings).toEqual([]);
    expect(getCompiledEffectOperation(
      internalOnly,
      'note.draft',
      1,
      'application_job'
    )).toBeUndefined();
    expect(getCompiledRegisteredConsumerEffectOperation(
      internalOnly,
      refs.consumer.key,
      refs.consumer.version
    )).toBeDefined();
  });

  test('seals an exact registered-job join in only the deterministic internal manifest', async () => {
    const observed = tracker();
    const registry = await createOperationRegistry(fixture({
      registeredJob: true,
      operatorBinding: false,
      tracker: observed
    }));
    const resolved = getCompiledRegisteredJobEffectOperation(
      registry,
      refs.job.key,
      refs.job.version
    );
    expect(resolved).toMatchObject({
      operation: { definition: { name: 'note.draft', version: 1 } },
      binding: {
        surface: 'application_job',
        lane: 'registered_job',
        job: refs.job,
        inputProjection: refs.jobInputProjection,
        capabilityRevisionId: refs.jobCapabilityRevisionId,
        authorityCitation: refs.jobAuthorityCitation
      }
    });
    expect(registry.safeManifest.operations).toEqual([]);
    expect(JSON.stringify(registry.safeManifest)).not.toContain(refs.job.key);
    expect(registry.internalManifest.bindings).toEqual([{
      kind: 'registered_job',
      selector: refs.job,
      operation: { name: 'note.draft', version: 1 },
      operationInputSchema: refs.input,
      inputProjection: refs.jobInputProjection,
      capabilityRevisionId: refs.jobCapabilityRevisionId,
      authorityCitation: refs.jobAuthorityCitation,
      resultProjection: refs.projection,
      resultSchema: refs.projected,
      accessLane: registeredJobLane
    }]);
    expect(registry.internalManifest.operationRegistryDigestSha256)
      .toBe(registry.manifestDigestSha256);
    expect(registry.internalManifestDigestSha256)
      .not.toBe(registry.manifestDigestSha256);
    const rebuilt = await createOperationRegistry(fixture({
      registeredJob: true,
      operatorBinding: false
    }));
    expect(rebuilt.internalManifestDigestSha256).toBe(registry.internalManifestDigestSha256);

    const anchorResolutions: string[] = [];
    const builder = createEffectInvocationBuilder(registry, {
      registeredJobAnchorResolver: {
        resolve: ({ job, jobId }) => {
          anchorResolutions.push(`${job.key}@${job.version}:${jobId}`);
          return { registeredIdempotencyIdentity: 'semantic-note-job:alpha' };
        }
      }
    });
    const first = await builder.buildRegisteredJob({
      job: refs.job,
      jobId: refs.jobId,
      correlationId: correlationIds[0],
      businessInput: { value: 'alpha', mode: 'success' }
    });
    const second = await builder.buildRegisteredJob({
      job: refs.job,
      jobId: refs.jobId,
      correlationId: correlationIds[1],
      businessInput: { value: 'alpha', mode: 'success' }
    });
    expect(first.surface).toBe('application_job');
    expect(second.correlationId).toBe(correlationIds[1]);
    expect(anchorResolutions).toEqual([
      `${refs.job.key}@${refs.job.version}:${refs.jobId}`,
      `${refs.job.key}@${refs.job.version}:${refs.jobId}`
    ]);
    expect(observed.rawKeysSeen).toEqual([
      `registered-job:${refs.job.key}@${refs.job.version}:${refs.jobId}:semantic-note-job:alpha`,
      `registered-job:${refs.job.key}@${refs.job.version}:${refs.jobId}:semantic-note-job:alpha`
    ]);
    expect(JSON.stringify(first)).not.toContain('semantic-note-job');

    await expect(builder.buildRegisteredJob({
      job: definitionRef('job.payload-selected-target'),
      jobId: refs.jobId,
      correlationId: correlationIds[0],
      businessInput: { value: 'alpha', mode: 'success' }
    })).rejects.toMatchObject({ phase: 'binding' });
    await expect(builder.buildRegisteredJob({
      job: refs.job,
      jobId: refs.jobId,
      correlationId: correlationIds[0],
      businessInput: {
        value: 'alpha',
        mode: 'success',
        targetOperation: 'note.commit',
        capabilityRevisionId: 'payload-selected',
        authorityCitationId: 'payload-selected'
      }
    })).rejects.toBeInstanceOf(OperationInputError);
  });

  test('rejects duplicate and lane-substituted registered-job bindings', async () => {
    const source = fixture({ registeredJob: true });
    await expect(createOperationRegistry({
      ...source,
      effectOperations: (source.effectOperations ?? []).map((operation) => ({
        ...operation,
        registeredJobBindings: [
          ...(operation.registeredJobBindings ?? []),
          ...(operation.registeredJobBindings ?? [])
        ]
      }))
    })).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'duplicate_registered_job_binding' })
      ])
    });
    await expect(createOperationRegistry({
      ...source,
      effectOperations: (source.effectOperations ?? []).map((operation) => ({
        ...operation,
        registeredJobBindings: (operation.registeredJobBindings ?? []).map((binding) => ({
          ...binding,
          lane: 'registered_consumer' as never
        }))
      }))
    })).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'unsupported_registered_job_binding' })
      ])
    });
  });

  test('rejects duplicate, substituted, and unknown registered-consumer selectors', async () => {
    const duplicated = fixture({ registeredConsumer: true });
    const duplicateSource: OperationRegistrySource = {
      ...duplicated,
      effectOperations: (duplicated.effectOperations ?? []).map((operation) => ({
        ...operation,
        registeredConsumerBindings: [
          ...(operation.registeredConsumerBindings ?? []),
          ...(operation.registeredConsumerBindings ?? [])
        ]
      }))
    };
    await expect(createOperationRegistry(duplicateSource)).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'duplicate_registered_consumer_binding' })
      ])
    });

    const substituted = fixture({ registeredConsumer: true });
    const substitutedSource: OperationRegistrySource = {
      ...substituted,
      effectOperations: (substituted.effectOperations ?? []).map((operation) => ({
        ...operation,
        registeredConsumerBindings: (operation.registeredConsumerBindings ?? []).map(
          (binding) => ({ ...binding, lane: 'registered_job' as never })
        )
      }))
    };
    await expect(createOperationRegistry(substitutedSource)).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'unsupported_registered_consumer_binding' })
      ])
    });

    const internalOnly = await createOperationRegistry(fixture({
      registeredConsumer: true,
      operatorBinding: false
    }));
    await expect(createEffectInvocationBuilder(internalOnly).buildRegisteredConsumer({
      consumer: definitionRef('consumer.payload-selected-operation'),
      correlationId: correlationIds[0],
      businessInput: { value: 'ignored' },
      verifiedEvidence: {},
      rawIdempotencyKey: 'server-derived'
    })).rejects.toMatchObject({ phase: 'binding' });
  });

  test('accepts closed draft and commit definitions but rejects an effect/handler mismatch', async () => {
    const registry = await createOperationRegistry(fixture({ effect: 'draft', handlerEffect: 'draft' }));
    expect(registry.operatorHttpEffectBindings).toEqual([{
      operationName: 'note.draft',
      operationVersion: 1,
      surface: 'operator_http',
      method: 'POST',
      path: '/api/test/note-drafts',
      input: 'body'
    }]);
    expect(Object.isFrozen(registry.operatorHttpEffectBindings)).toBe(true);
    expect(Object.isFrozen(registry.operatorHttpEffectBindings[0])).toBe(true);
    await expect(createOperationRegistry(fixture({ effect: 'commit', handlerEffect: 'commit' }))).resolves.toBeDefined();
    try {
      await createOperationRegistry(fixture({ effect: 'commit', handlerEffect: 'draft' }));
      throw new Error('expected registry failure');
    } catch (error) {
      expect(error).toBeInstanceOf(OperationRegistryValidationError);
      expect((error as OperationRegistryValidationError).issues.map((issue) => issue.code)).toContain('handler_effect_mismatch');
    }
  });

  test('captures exact effect implementations and exposes no mutable compiled maps', async () => {
    const observed = tracker();
    const source = fixture({ tracker: observed });
    const registry = await createOperationRegistry(source);
    const sourceHandler = source.effectHandlers?.[0];
    const sourceProjection = source.projections[0];
    const sourceContributionSchema = source.schemas.find(
      (registration) => registration.reference.key === refs.contribution.key
    );
    const sourceOutcome = source.effectOperations?.[0]?.outcomes.find(
      (outcome) => outcome.kind === 'authority.denied'
    );
    if (!sourceHandler || !sourceProjection || !sourceContributionSchema || !sourceOutcome) {
      throw new TypeError('missing mutable-source fixture');
    }
    (sourceHandler as { handle: EffectHandlerRegistration['handle'] }).handle = async () => {
      throw new Error('post-startup handler substitution');
    };
    (sourceProjection as { project: ReadProjectionRegistration['project'] }).project = () => ({
      kind: 'outcome',
      outcome: {
        class: 'provider_failure', kind: 'provider.substituted', retryable: false,
        subjects: [], detail: null, detailSchemaVersion: 1
      }
    });
    (sourceContributionSchema as { schema: RegisteredOperationSchema['schema'] }).schema = z.never();
    expect(() => {
      (sourceOutcome as { retryable: boolean }).retryable = true;
    }).toThrow();

    const compiled = getCompiledEffectOperation(registry, 'note.draft', 1, 'operator_http')?.operation;
    if (!compiled) throw new TypeError('missing compiled operation');
    expect(() => (compiled.outcomes as Map<string, unknown>).set('forged:outcome', {})).toThrow();
    expect(() => (compiled.schemas as Map<string, unknown>).clear()).toThrow();

    const result = await createEffectOperationExecutor({
      registry,
      unitOfWork: new InMemoryEffectUnitOfWork()
    }).execute(await sealed({ builder: createEffectInvocationBuilder(registry) }));
    expect(result.kind).toBe('success');
    expect(observed.handlerCalls).toBe(1);
  });

  test('rejects missing idempotency-conflict compatibility and non-effect vocabulary', async () => {
    const missing = fixture();
    const withoutConflict: OperationRegistrySource = {
      ...missing,
      effectOperations: (missing.effectOperations ?? []).map((operation) => ({ ...operation, outcomes: [] }))
    };
    await expect(createOperationRegistry(withoutConflict)).rejects.toBeInstanceOf(OperationRegistryValidationError);

    const invalid = fixture();
    const readPretendingToWrite: OperationRegistrySource = {
      ...invalid,
      effectOperations: (invalid.effectOperations ?? []).map((operation) => ({ ...operation, effect: 'read' as never }))
    };
    try {
      await createOperationRegistry(readPretendingToWrite);
      throw new Error('expected registry failure');
    } catch (error) {
      expect((error as OperationRegistryValidationError).issues.map((issue) => issue.code)).toContain('invalid_effect_contract');
    }
  });

  test('rejects a generic builder, effect substitution, lane substitution, and unactivated public effects', async () => {
    const genericSource = fixture();
    const generic: OperationRegistrySource = {
      ...genericSource,
      effectContextBuilders: [...(genericSource.effectContextBuilders ?? []), {
        reference: definitionRef('context.generic-effect-extra'),
        build: (() => ({
          kind: 'outcome',
          outcome: {
            class: 'access_denied', kind: 'authority.denied', retryable: false,
            subjects: [], detail: null, detailSchemaVersion: 1
          }
        })) as never
      }]
    };
    await expect(createOperationRegistry(generic)).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ code: 'untrusted_context_builder' })])
    });

    const effectSource = fixture({ effect: 'draft' });
    const effectMismatch: OperationRegistrySource = {
      ...effectSource,
      effectOperations: (effectSource.effectOperations ?? []).map((operation) => ({
        ...operation,
        effect: 'commit' as const
      }))
    };
    await expect(createOperationRegistry(effectMismatch)).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ code: 'context_builder_effect_mismatch' })])
    });

    const competingLane = parseOperationAccessLane({
      kind: 'operator', surface: 'operator_http',
      policy: { key: 'authority.competing-effect-test', version: 1 }
    });
    const laneSource = fixture();
    const laneMismatch: OperationRegistrySource = {
      ...laneSource,
      effectOperations: (laneSource.effectOperations ?? []).map((operation) => ({
        ...operation,
        accessLanes: [competingLane]
      }))
    };
    await expect(createOperationRegistry(laneMismatch)).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ code: 'context_builder_access_lane_mismatch' })])
    });

    const publicLane = parseOperationAccessLane({
      kind: 'public_ceremony', surface: 'public_http',
      policy: { key: 'authority.public-ceremony-test', version: 1 }
    });
    const publicSource = fixture();
    const publicEffect: OperationRegistrySource = {
      ...publicSource,
      effectOperations: (publicSource.effectOperations ?? []).map((operation) => ({
        ...operation,
        accessLanes: [publicLane]
      }))
    };
    await expect(createOperationRegistry(publicEffect)).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ code: 'public_effect_lane_unactivated' })])
    });
  });

  test('isolates continuation-backed public effects behind one exact conformance boundary', async () => {
    const boundary = createPublicEffectConformanceBoundary();
    const source = fixture({
      operatorBinding: false,
      publicBinding: true,
      publicEffectConformance: boundary
    });

    await expect(createOperationRegistry(source)).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'public_effect_lane_unactivated' })
      ])
    });

    const registry = await boundary.createRegistry(source);
    expect(registry.operatorHttpEffectBindings).toEqual([]);
    expect(registry.publicHttpEffectBindings).toEqual([{
      operationName: 'note.draft',
      operationVersion: 1,
      surface: 'public_http',
      method: 'POST',
      path: '/api/public/test/note-drafts',
      input: 'body',
      browserResumption: {
        kind: 'server_ref',
        referenceSchema: refs.input,
        requestCodec: definitionRef('codec.public-note-effect-request'),
        maximumReferenceBytes: 256
      }
    }]);
    expect(registry.safeManifest.operations[0]?.enabledBindings[0]).toMatchObject({
      protocol: 'http',
      surface: 'public_http',
      browserResumption: { kind: 'server_ref' }
    });

    const runtime = await boundary.createRuntime({
      source,
      read: {
        operationalTrace: { emit() {} },
        immutableAudit: { append() {} },
        clock: { now: () => authorityInstant },
        newInvocationId: () => authorityIds.invocation
      },
      unitOfWork: new InMemoryEffectUnitOfWork()
    });
    expect(() => assertApplicationOperationRuntime(runtime)).not.toThrow();
    expect(runtime.registry.publicHttpEffectBindings).toEqual(registry.publicHttpEffectBindings);
    await expect(createApplicationOperationRuntime({
      source,
      read: {
        operationalTrace: { emit() {} },
        immutableAudit: { append() {} },
        clock: { now: () => authorityInstant },
        newInvocationId: () => authorityIds.invocation
      },
      unitOfWork: new InMemoryEffectUnitOfWork()
    })).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'public_effect_lane_unactivated' })
      ])
    });

    const otherBoundary = createPublicEffectConformanceBoundary();
    await expect(otherBoundary.createRegistry(source)).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'public_effect_context_unactivated' })
      ])
    });

    const publicOpenLane = parseOperationAccessLane({
      kind: 'public_open',
      surface: 'public_http',
      policy: { key: 'authority.public-open-effect-test', version: 1 }
    });
    const publicOpenSource: OperationRegistrySource = {
      ...source,
      effectOperations: (source.effectOperations ?? []).map((operation) => ({
        ...operation,
        accessLanes: [publicOpenLane]
      }))
    };
    await expect(boundary.createRegistry(publicOpenSource)).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'public_effect_lane_unactivated' })
      ])
    });
  });

  test('pins one credential verifier profile to the exact operation version', async () => {
    await expect(createOperationRegistry(fixture({
      builderCredentialProfile: rotatedKeyProfile,
      operationCredentialProfile: keyProfile
    }))).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'context_builder_idempotency_profile_mismatch' })
      ])
    });
  });

  test('pins one server-keyed request-hash profile to the exact operation version', async () => {
    await expect(createOperationRegistry(fixture({
      builderRequestHashProfile: definitionRef('request-hash.rotated-input'),
      operationRequestHashProfile: refs.requestHash
    }))).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'context_builder_request_hash_profile_mismatch' })
      ])
    });
  });

  test('rejects missing or malformed audit declarations and unresolved target/profile catalogs', async () => {
    const missingSource = fixture();
    await expect(createOperationRegistry({
      ...missingSource,
      effectOperations: (missingSource.effectOperations ?? []).map((operation) => ({
        ...operation,
        audit: undefined as never
      }))
    })).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ code: 'invalid_effect_audit' })])
    });

    const malformedSource = fixture();
    await expect(createOperationRegistry({
      ...malformedSource,
      effectOperations: (malformedSource.effectOperations ?? []).map((operation) => ({
        ...operation,
        audit: { mode: 'optional', target: refs.audit } as never
      }))
    })).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ code: 'invalid_effect_audit' })])
    });

    const unknownTargetSource = fixture();
    await expect(createOperationRegistry({
      ...unknownTargetSource,
      effectOperations: (unknownTargetSource.effectOperations ?? []).map((operation) => ({
        ...operation,
        audit: { mode: 'required', target: definitionRef('audit.unknown') }
      }))
    })).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ code: 'unknown_effect_audit_target' })])
    });

    const duplicateTargetSource = fixture();
    await expect(createOperationRegistry({
      ...duplicateTargetSource,
      operationAuditTargets: [
        ...(duplicateTargetSource.operationAuditTargets ?? []),
        ...(duplicateTargetSource.operationAuditTargets ?? [])
      ]
    })).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ code: 'duplicate_reference' })])
    });

    const invalidProfileSource = fixture();
    await expect(createOperationRegistry({
      ...invalidProfileSource,
      operationAuditRecordProfiles: [{
        reference: refs.auditRecordProfile,
        kind: 'canonical_json',
        maximumBytes: 0
      }]
    })).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'invalid_effect_audit_record_profile' }),
        expect.objectContaining({ code: 'unknown_effect_audit_record_profile' })
      ])
    });

    const unknownProfileSource = fixture();
    await expect(createOperationRegistry({
      ...unknownProfileSource,
      operationAuditTargets: [{
        reference: refs.audit,
        kind: 'operation_audit_record',
        recordProfile: definitionRef('audit-record.unknown')
      }]
    })).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'unknown_effect_audit_record_profile' })
      ])
    });
  });
});

describe('sealed ordinary effect executor', () => {
  test('operation-log hooks can prove the exact issued receipt object for its sealed invocation', async () => {
    const test = await harness();
    const invocation = await sealed({ builder: test.builder });
    let observed = false;
    test.port.receiptObserver = (receipt) => {
      expect(() => assertTerminalEffectReceiptIssuedForInvocation({ invocation, receipt }))
        .not.toThrow();
      const clone = structuredClone(receipt) as TerminalEffectReceipt;
      expect(() => assertTerminalEffectReceiptIssuedForInvocation({ invocation, receipt: clone }))
        .toThrow();
      observed = true;
    };
    await test.executor.execute(invocation);
    expect(observed).toBe(true);
  });

  test('commits domain contribution, immutable operation log, and owner effect contribution in strict order', async () => {
    const test = await harness();
    const result = await test.executor.execute(await sealed({ builder: test.builder }));
    expect(result.kind).toBe('success');
    expect(test.port.trace).toEqual([
      'replay_preflight', 'begin', 'authority_recheck', 'replay_recheck', 'snapshot',
      'domain', 'operation_log', 'effect_contribution', 'release', 'commit'
    ]);
    expect(test.port.domainCount).toBe(1);
    expect(test.port.receiptCount).toBe(1);
    expect(test.port.childCount).toBe(1);
    expect(test.port.storedAudits).toHaveLength(0);
    const receipt = test.port.storedReceipts[0];
    expect(receipt && Object.isFrozen(receipt)).toBe(true);
    expect(receipt && Object.isFrozen(receipt.result)).toBe(true);
    expect(test.port.storedChildren[0]?.receiptId).toBe(receipt?.ref.id);
    expect(test.observed.handlerSnapshotKeys).toEqual([['currentValue']]);
  });

  test('rejects a replay whose embedded receipt ref differs from the stored receipt identity', async () => {
    const test = await harness();
    await test.executor.execute(await sealed({ builder: test.builder }));
    const stored = test.port.storedReceipts[0];
    if (!stored || (stored.result.kind === 'outcome' && stored.result.terminal !== true)) {
      throw new TypeError('missing replay-integrity fixture');
    }
    const storedResult = stored.result;
    test.port.receiptOverride = {
      ...structuredClone(stored),
      result: {
        ...structuredClone(storedResult),
        receipt: {
          ...storedResult.receipt,
          operationName: 'note.substituted'
        }
      }
    };
    await expect(test.executor.execute(await sealed({ builder: test.builder })))
      .rejects.toMatchObject({ phase: 'replay_preflight' });
    expect(test.observed.handlerCalls).toBe(1);
    expect(test.port.commits).toBe(1);
  });

  test('same identity/hash replays, changed hash is detail-free, and principal and scope partitions are isolated', async () => {
    const test = await harness();
    const first = await test.executor.execute(await sealed({ builder: test.builder, correlationId: correlationIds[0] }));
    const replay = await test.executor.execute(await sealed({ builder: test.builder, correlationId: correlationIds[1] }));
    expect(replay).toEqual(first);
    expect(test.observed.handlerCalls).toBe(1);
    expect(test.port.commits).toBe(1);
    expect(test.port.storedAudits).toEqual([]);

    const changed = await test.executor.execute(await sealed({ builder: test.builder, value: 'changed', correlationId: correlationIds[1] }));
    expect(changed).toEqual({
      kind: 'outcome',
      outcome: {
        class: 'idempotency_conflict',
        kind: 'operation.request_changed',
        retryable: false,
        subjects: [],
        detail: null,
        detailSchemaVersion: 1
      },
      terminal: false,
      correlationId: correlationIds[1]
    });
    expect('receipt' in changed).toBe(false);
    expect(test.observed.handlerCalls).toBe(1);
    expect(test.port.receiptCount).toBe(1);

    const isolated = await test.executor.execute(await sealed({ builder: test.builder, principal: 'grace', correlationId: correlationIds[2] }));
    expect(isolated.kind).toBe('success');
    expect(test.observed.handlerCalls).toBe(2);
    expect(test.port.receiptCount).toBe(2);
    expect(test.port.commits).toBe(2);

    const isolatedScope = await test.executor.execute(await sealed({
      builder: test.builder,
      scope: 'workspace-beta',
      correlationId: correlationIds[2]
    }));
    expect(isolatedScope.kind).toBe('success');
    expect(test.observed.handlerCalls).toBe(3);
    expect(test.port.receiptCount).toBe(3);
    expect(test.port.commits).toBe(3);
  });

  test('raw idempotency material exists only at the trusted builder boundary', async () => {
    const test = await harness();
    const invocation = await sealed({ builder: test.builder, rawKey: 'raw-key-never-forwarded' });
    expect(JSON.stringify(invocation)).not.toContain('raw-key-never-forwarded');
    await test.executor.execute(invocation);
    expect(test.observed.rawKeysSeen).toEqual(['raw-key-never-forwarded']);
    expect(JSON.stringify(test.port.storedReceipts)).not.toContain('raw-key-never-forwarded');
    const audits = JSON.stringify(test.port.storedAudits);
    expect(audits).not.toContain('raw-key-never-forwarded');
    expect(audits).not.toContain('requestHash');
    expect(audits).not.toContain('idempotencyKey');
    expect(audits).not.toContain('grants');
    expect(audits).not.toContain('detail');
    expect(JSON.stringify(test.port.trace)).not.toContain('raw-key-never-forwarded');
  });

  test('handler receipt/correlation forgery is rejected before domain mutation', async () => {
    const test = await harness();
    await expect(test.executor.execute(await sealed({ builder: test.builder, mode: 'forge' }))).rejects.toMatchObject({
      name: 'OperationExecutionError',
      phase: 'contribution'
    } satisfies Partial<OperationExecutionError>);
    expect(test.port.domainCount).toBe(0);
    expect(test.port.receiptCount).toBe(0);
    expect(test.port.childCount).toBe(0);
    expect(test.port.trace.at(-1)).toBe('rollback');
  });

  test('handler-authored audit evidence is reserved and rejected before domain mutation', async () => {
    const test = await harness();
    await expect(test.executor.execute(await sealed({
      builder: test.builder,
      mode: 'reserved-audit'
    }))).rejects.toMatchObject({
      name: 'OperationExecutionError',
      phase: 'contribution'
    } satisfies Partial<OperationExecutionError>);
    expect(test.port.domainCount).toBe(0);
    expect(test.port.receiptCount).toBe(0);
    expect(test.port.childCount).toBe(0);
    expect(test.port.storedAudits).toHaveLength(0);
    expect(test.port.trace.at(-1)).toBe('rollback');
  });

  test('every injected transaction crash rolls back domain, operation log, and owner effect contribution', async () => {
    for (const failure of ['snapshot', 'domain', 'parent', 'child', 'release', 'commit'] as const) {
      const test = await harness({ failure });
      await expect(test.executor.execute(await sealed({ builder: test.builder }))).rejects.toBeInstanceOf(OperationExecutionError);
      expect({ failure, domain: test.port.domainCount, receipts: test.port.receiptCount, children: test.port.childCount, commits: test.port.commits })
        .toEqual({ failure, domain: 0, receipts: 0, children: 0, commits: 0 });
      expect(test.port.trace.at(-1)).toBe('rollback');
    }
  });

  test('handler and projection crashes roll back without a terminal receipt', async () => {
    const handlerCrash = await harness();
    await expect(handlerCrash.executor.execute(await sealed({ builder: handlerCrash.builder, mode: 'crash' }))).rejects.toMatchObject({ phase: 'handler' });
    expect(handlerCrash.port.receiptCount).toBe(0);

    const projectionCrash = await harness({ asyncProjection: true });
    await expect(projectionCrash.executor.execute(await sealed({ builder: projectionCrash.builder }))).rejects.toMatchObject({ phase: 'projection' });
    expect(projectionCrash.port.domainCount).toBe(0);
    expect(projectionCrash.port.receiptCount).toBe(0);

    const nondeterministicProjection = await harness({ nondeterministicProjection: true });
    await expect(nondeterministicProjection.executor.execute(await sealed({
      builder: nondeterministicProjection.builder
    }))).rejects.toMatchObject({ phase: 'projection' });
    expect(nondeterministicProjection.port.domainCount).toBe(0);
    expect(nondeterministicProjection.port.receiptCount).toBe(0);

    const semanticRewrite = await harness({ semanticRewriteProjection: true });
    await expect(semanticRewrite.executor.execute(await sealed({ builder: semanticRewrite.builder })))
      .rejects.toMatchObject({ phase: 'projection' });
    expect(semanticRewrite.port.domainCount).toBe(0);
    expect(semanticRewrite.port.receiptCount).toBe(0);
  });

  test('handler snapshots cannot smuggle nested executable or accessor capabilities into the transaction', async () => {
    let accessorCalls = 0;
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, 'external', {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return 'must-not-run';
      }
    });
    const hidden = { visible: true } as Record<string, unknown>;
    Object.defineProperty(hidden, 'external', {
      enumerable: false,
      value: { mutable: true }
    });
    for (const unsafe of [
      { nested: { external: () => Promise.resolve('network') } },
      accessor,
      hidden,
      { nested: { value: 1, [Symbol('capability')]: 'hidden' } }
    ]) {
      const test = await harness();
      test.port.handlerSnapshot = unsafe;
      await expect(test.executor.execute(await sealed({ builder: test.builder }))).rejects.toMatchObject({
        phase: 'write_snapshot'
      });
      expect(test.observed.handlerCalls).toBe(0);
      expect(test.port.domainCount).toBe(0);
      expect(test.port.receiptCount).toBe(0);
    }
    expect(accessorCalls).toBe(0);
  });

  test('startup closes the execution family, phase, terminalization, and resolver joins', async () => {
    const missingFamily = fixture();
    await expect(createOperationRegistry({ ...missingFamily, effectExecutionFamilies: [] })).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ code: 'missing_definition_reference' })])
    });

    const mismatchedPhaseSource = fixture();
    const phaseOperation = mismatchedPhaseSource.effectOperations?.[0];
    const originalPhase = mismatchedPhaseSource.effectPhases?.[0];
    if (!phaseOperation || !originalPhase) throw new TypeError('missing phase fixture');
    const mismatchedPhase = createSingleUnitOfWorkPhaseRegistration({
      reference: originalPhase.reference,
      family: originalPhase.family,
      operation: { name: phaseOperation.name, version: phaseOperation.version + 1 },
      effect: originalPhase.effect,
      handler: originalPhase.handler,
      handlerCapability: originalPhase.handlerCapability,
      contributionSchema: originalPhase.contributionSchema,
      terminalization: originalPhase.terminalization,
      terminalOutcomeKeys: originalPhase.terminalOutcomeKeys,
      contentionOutcome: originalPhase.contentionOutcome
    });
    await expect(createOperationRegistry({
      ...mismatchedPhaseSource,
      effectPhases: [mismatchedPhase]
    })).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ code: 'execution_phase_operation_mismatch' })])
    });

    const wrongFamily = fixture();
    await expect(createOperationRegistry({
      ...wrongFamily,
      effectOperations: (wrongFamily.effectOperations ?? []).map((operation) => ({
        ...operation,
        execution: { ...operation.execution, kind: 'prepared_single_unit_of_work' as never }
      }))
    })).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ code: 'invalid_effect_execution_contract' })])
    });

    const asyncHandler = fixture();
    await expect(createOperationRegistry({
      ...asyncHandler,
      effectHandlers: (asyncHandler.effectHandlers ?? []).map((handler) => ({
        ...handler,
        async handle(value: Parameters<typeof handler.handle>[0]) {
          return handler.handle(value);
        }
      }))
    })).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ code: 'async_effect_handler' })])
    });

    const nondeterministicTerminalization = fixture();
    const originalTerminalization = nondeterministicTerminalization.terminalizationResolvers?.[0];
    const operation = nondeterministicTerminalization.effectOperations?.[0];
    const registeredPhase = nondeterministicTerminalization.effectPhases?.[0];
    if (!originalTerminalization || !operation || !registeredPhase) throw new TypeError('missing terminalization fixture');
    let sequence = 0;
    const changing = createTerminalizationResolverRegistration({
      reference: originalTerminalization.reference,
      operation: { name: operation.name, version: operation.version },
      phase: registeredPhase.reference,
      resolve: () => ({ kind: sequence++ % 2 === 0 ? 'terminal' : 'nonterminal' })
    });
    await expect(createOperationRegistry({
      ...nondeterministicTerminalization,
      terminalizationResolvers: [changing]
    })).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ code: 'unsafe_terminalization_resolver' })])
    });

    const overTerminalSource = fixture();
    const overTerminalOperation = overTerminalSource.effectOperations?.[0];
    const overTerminalPhase = overTerminalSource.effectPhases?.[0];
    const overTerminalResolver = overTerminalSource.terminalizationResolvers?.[0];
    if (!overTerminalOperation || !overTerminalPhase || !overTerminalResolver) {
      throw new TypeError('missing over-terminalization fixture');
    }
    await expect(createOperationRegistry({
      ...overTerminalSource,
      terminalizationResolvers: [createTerminalizationResolverRegistration({
        reference: overTerminalResolver.reference,
        operation: { name: overTerminalOperation.name, version: overTerminalOperation.version },
        phase: overTerminalPhase.reference,
        resolve: () => ({ kind: 'terminal' })
      })]
    })).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'unsafe_terminal_outcome_resolution' })
      ])
    });

    const conditionalSuccessSource = fixture();
    const conditionalSuccessOperation = conditionalSuccessSource.effectOperations?.[0];
    const conditionalSuccessPhase = conditionalSuccessSource.effectPhases?.[0];
    const conditionalSuccessResolver = conditionalSuccessSource.terminalizationResolvers?.[0];
    if (!conditionalSuccessOperation || !conditionalSuccessPhase || !conditionalSuccessResolver) {
      throw new TypeError('missing conditional-success terminalization fixture');
    }
    await expect(createOperationRegistry({
      ...conditionalSuccessSource,
      terminalizationResolvers: [createTerminalizationResolverRegistration({
        reference: conditionalSuccessResolver.reference,
        operation: {
          name: conditionalSuccessOperation.name,
          version: conditionalSuccessOperation.version
        },
        phase: conditionalSuccessPhase.reference,
        resolve: (evidence) => evidence.result.kind === 'success' && evidence.hasDomainContribution
          ? { kind: 'nonterminal' }
          : conditionalSuccessResolver.resolve(evidence)
      })]
    })).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'unsafe_terminalization_resolver' })
      ])
    });

    const undeclaredTerminalSource = fixture();
    const undeclaredPhase = undeclaredTerminalSource.effectPhases?.[0];
    if (!undeclaredPhase) throw new TypeError('missing terminal allowlist fixture');
    await expect(createOperationRegistry({
      ...undeclaredTerminalSource,
      effectPhases: [createSingleUnitOfWorkPhaseRegistration({
        reference: undeclaredPhase.reference,
        family: undeclaredPhase.family,
        operation: undeclaredPhase.operation,
        effect: undeclaredPhase.effect,
        handler: undeclaredPhase.handler,
        handlerCapability: undeclaredPhase.handlerCapability,
        contributionSchema: undeclaredPhase.contributionSchema,
        terminalization: undeclaredPhase.terminalization,
        terminalOutcomeKeys: ['provider_failure:provider.unregistered'],
        contentionOutcome: undeclaredPhase.contentionOutcome
      })]
    })).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ code: 'undeclared_terminal_outcome' })])
    });

    const asyncAutonomy = fixture();
    const originalEvidence = asyncAutonomy.autonomyEvidenceResolvers?.[0];
    if (!originalEvidence) throw new TypeError('missing autonomy evidence fixture');
    const promised = createAutonomyEvidenceResolverRegistration({
      reference: originalEvidence.reference,
      operation: originalEvidence.operation,
      resolve: (value) => Promise.resolve(originalEvidence.resolve(value))
    });
    await expect(createOperationRegistry({
      ...asyncAutonomy,
      autonomyEvidenceResolvers: [promised]
    })).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ code: 'unsafe_autonomy_resolver' })])
    });

    const forgedApproval = fixture();
    const approval = forgedApproval.renewedApprovalResolvers?.[0];
    if (!approval) throw new TypeError('missing approval fixture');
    await expect(createOperationRegistry({
      ...forgedApproval,
      renewedApprovalResolvers: [{ ...approval }]
    })).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ code: 'untrusted_approval_resolver' })])
    });

    const malformedApproval = fixture({ effect: 'commit', handlerEffect: 'commit' });
    const malformedApprovalResolver = malformedApproval.renewedApprovalResolvers?.[0];
    if (!malformedApprovalResolver) throw new TypeError('missing malformed approval fixture');
    await expect(createOperationRegistry({
      ...malformedApproval,
      renewedApprovalResolvers: [createRenewedApprovalResolverRegistration({
        reference: malformedApprovalResolver.reference,
        operation: malformedApprovalResolver.operation,
        resolve: () => ({
          approverCurrentlyAuthorized: true,
          evidence: {
            id: '',
            unexpectedStructuralApproval: true
          }
        } as never)
      })]
    })).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ code: 'unsafe_autonomy_resolver' })])
    });

    const malformedIntervention = fixture();
    const preflight = malformedIntervention.autonomyPreflights?.[0];
    if (!preflight) throw new TypeError('missing autonomy preflight fixture');
    expect(() => createAutonomyPreflightRegistration({
      reference: preflight.reference,
      operation: preflight.operation,
      policy: preflight.policy,
      riskResolver: preflight.riskResolver,
      evidenceResolver: preflight.evidenceResolver,
      approvalResolver: preflight.approvalResolver,
      interventionOutcomes: {
        ...preflight.interventionOutcomes,
        block: {
          ...preflight.interventionOutcomes.block,
          class: 'provider_failure'
        }
      }
    })).toThrow('exact outcome');
  });

  test('invalid autonomy evidence fails closed before the handler', async () => {
    const invalidEvidenceSource = fixture();
    const originalEvidence = invalidEvidenceSource.autonomyEvidenceResolvers?.[0];
    if (!originalEvidence) throw new TypeError('missing autonomy evidence fixture');
    const invalidEvidence = createAutonomyEvidenceResolverRegistration({
      reference: originalEvidence.reference,
      operation: originalEvidence.operation,
      resolve: (value) => {
        const resolved = originalEvidence.resolve(value);
        return value.subject.requestHashSha256 === 'a'.repeat(64)
          ? resolved
          : { ...resolved, failure: { kind: 'unknown_failure' } as never };
      }
    });
    const invalidRegistry = await createOperationRegistry({
      ...invalidEvidenceSource,
      autonomyEvidenceResolvers: [invalidEvidence]
    });
    const invalidPort = new InMemoryEffectUnitOfWork();
    await expect(createEffectOperationExecutor({ registry: invalidRegistry, unitOfWork: invalidPort })
      .execute(await sealed({ builder: createEffectInvocationBuilder(invalidRegistry) })))
      .rejects.toMatchObject({ phase: 'autonomy_preflight' });
    expect(invalidPort.trace).toEqual([
      'replay_preflight', 'begin', 'authority_recheck', 'replay_recheck', 'rollback'
    ]);
  });

  test('bounds and consequential approval gate before UnitOfWork, while exact sealed approval proceeds', async () => {
    const overBoundsSource = fixture();
    const originalEvidence = overBoundsSource.autonomyEvidenceResolvers?.[0];
    if (!originalEvidence) throw new TypeError('missing autonomy evidence fixture');
    const overBounds = createAutonomyEvidenceResolverRegistration({
      reference: originalEvidence.reference,
      operation: originalEvidence.operation,
      resolve: (value) => {
        const resolved = originalEvidence.resolve(value);
        return {
          ...resolved,
          unattendedBounds: { ...resolved.hardBounds, maximumActions: 0 }
        };
      }
    });
    const overBoundsRegistry = await createOperationRegistry({
      ...overBoundsSource,
      autonomyEvidenceResolvers: [overBounds]
    });
    const overBoundsPort = new InMemoryEffectUnitOfWork();
    const overBoundsBuilder = createEffectInvocationBuilder(overBoundsRegistry);
    const overBoundsInvocation = await sealed({ builder: overBoundsBuilder });
    const overBoundsResult = await createEffectOperationExecutor({
      registry: overBoundsRegistry,
      unitOfWork: overBoundsPort
    }).execute(overBoundsInvocation);
    expect(overBoundsResult).toMatchObject({
      kind: 'outcome',
      terminal: false,
      outcome: { class: 'policy_violation', kind: 'autonomy.renewed_approval' }
    });
    expect(overBoundsPort.trace).toEqual([
      'replay_preflight', 'begin', 'authority_recheck', 'replay_recheck', 'commit'
    ]);
    const interventionEvidence = resolveEffectAutonomyExecutionEvidence({
      invocation: overBoundsInvocation,
      result: overBoundsResult
    });
    expect(interventionEvidence).toMatchObject({
      decision: {
        disposition: 'renewed_approval',
        request: { trigger: 'unattended_bounds_exceeded', requestedActions: 1 }
      },
      envelope: { unattendedBounds: { maximumActions: 0 } }
    });
    expect(Object.isFrozen(interventionEvidence)).toBe(true);
    expect(resolveEffectAutonomyExecutionEvidence({
      invocation: overBoundsInvocation,
      result: structuredClone(overBoundsResult)
    })).toBeUndefined();

    const consequentialSource = fixture({ effect: 'commit', handlerEffect: 'commit' });
    const approvalResolver = consequentialSource.renewedApprovalResolvers?.[0];
    if (!approvalResolver) throw new TypeError('missing consequential approval fixture');
    const absentApproval = createRenewedApprovalResolverRegistration({
      reference: approvalResolver.reference,
      operation: approvalResolver.operation,
      resolve: () => ({ approverCurrentlyAuthorized: false })
    });
    const gatedRegistry = await createOperationRegistry({
      ...consequentialSource,
      renewedApprovalResolvers: [absentApproval]
    });
    const gatedPort = new InMemoryEffectUnitOfWork();
    const gatedBuilder = createEffectInvocationBuilder(gatedRegistry);
    const gatedResult = await createEffectOperationExecutor({ registry: gatedRegistry, unitOfWork: gatedPort })
      .execute(await sealed({ builder: gatedBuilder, effect: 'commit' }));
    expect(gatedResult).toMatchObject({
      kind: 'outcome',
      terminal: false,
      outcome: { kind: 'autonomy.renewed_approval' }
    });
    expect(gatedPort.trace).toEqual([
      'replay_preflight', 'begin', 'authority_recheck', 'replay_recheck', 'commit'
    ]);

    const approved = await harness({ effect: 'commit', handlerEffect: 'commit' });
    const approvedInvocation = await sealed({
      builder: approved.builder,
      effect: 'commit'
    });
    const approvedResult = await approved.executor.execute(approvedInvocation);
    expect(approvedResult.kind).toBe('success');
    expect(approved.port.domainCount).toBe(1);
    const approvedEvidence = resolveEffectAutonomyExecutionEvidence({
      invocation: approvedInvocation,
      result: approvedResult
    });
    expect(approvedEvidence).toMatchObject({
      decision: { disposition: 'proceed' },
      approval: {
        approverCurrentlyAuthorized: true,
        evidence: { id: 'approval.note.commit' }
      },
      subject: {
        scopeSubjects: [{ kind: 'workspace', id: authorityIds.workspaceAlpha }]
      }
    });
    expect(canonicalJsonText(approved.observed.handlerContexts[0])).not.toContain('autonomy_execution_directive');
  });

  test('terminalization owns terminality and nonterminal phase results cannot write or mint receipts', async () => {
    const test = await harness();
    const result = await test.executor.execute(await sealed({
      builder: test.builder,
      mode: 'nonterminal'
    }));
    expect(result).toMatchObject({
      kind: 'outcome',
      terminal: false,
      outcome: { kind: 'authority.denied' }
    });
    expect(test.port.domainCount).toBe(0);
    expect(test.port.receiptCount).toBe(0);
    expect(test.port.storedAudits).toEqual([]);

    const compiled = getCompiledEffectOperation(test.registry, 'note.draft', 1, 'operator_http')?.operation;
    const context = test.observed.handlerContexts[0];
    if (!compiled || !context) throw new TypeError('missing sealed nonterminal audit fixture');
    const authorityRecheck = await recheckEffectInvocationCurrentAuthority(context);
    expect(() => createNonterminalProgressOperationAuditRecord({
      context,
      definition: compiled.definition,
      auditTarget: compiled.auditTarget,
      auditRecordProfile: compiled.auditRecordProfile,
      result,
      authorityRecheck,
      reason: {
        kind: 'autonomy_intervention',
        autonomyDisposition: 'proceed'
      } as never
    })).toThrow('invalid_nonterminal_progress_reason');
    expect(() => createNonterminalProgressOperationAuditRecord({
      context,
      definition: compiled.definition,
      auditTarget: compiled.auditTarget,
      auditRecordProfile: compiled.auditRecordProfile,
      result,
      authorityRecheck,
      reason: { kind: 'phase_nonterminal', detail: 'must-not-persist' } as never
    })).toThrow('invalid_nonterminal_progress_reason');
  });

  test('audit seals reject disposition/result contradictions and denial-outcome substitution', async () => {
    const terminal = await harness();
    const terminalResult = await terminal.executor.execute(await sealed({ builder: terminal.builder }));
    const context = terminal.observed.handlerContexts[0];
    const compiled = getCompiledEffectOperation(terminal.registry, 'note.draft', 1, 'operator_http')?.operation;
    if (!context || !compiled || terminalResult.kind !== 'success') {
      throw new TypeError('missing audit-seal fixture');
    }
    const authorityRecheck = await recheckEffectInvocationCurrentAuthority(context);
    const requestChanged: EffectfulOperationResult = {
      kind: 'outcome',
      outcome: {
        class: 'idempotency_conflict',
        kind: 'operation.request_changed',
        retryable: false,
        subjects: [],
        detail: null,
        detailSchemaVersion: 1
      },
      terminal: false,
      correlationId: correlationIds[0]
    };
    const authorized = {
      context,
      definition: compiled.definition,
      auditTarget: compiled.auditTarget,
      auditRecordProfile: compiled.auditRecordProfile,
      authorityRecheck
    };
    expect(() => createTerminalNewOperationAuditRecord({
      ...authorized,
      result: requestChanged,
      receiptId: terminalResult.receipt.id
    })).toThrow('invalid_operation_audit_terminal_result');
    expect(() => createTerminalReplayOperationAuditRecord({
      ...authorized,
      result: terminalResult,
      relatedReceiptId: receiptIds[2]
    })).toThrow('invalid_operation_audit_terminal_result');
    expect(() => createIdempotencyConflictOperationAuditRecord({
      ...authorized,
      result: terminalResult
    })).toThrow('invalid_operation_audit_idempotency_conflict_result');

    const deniedSource = fixture({ denyAuthority: true });
    const deniedRegistry = await createOperationRegistry(deniedSource);
    const deniedBuilder = deniedSource.effectContextBuilders?.[0];
    const deniedCompiled = getCompiledEffectOperation(deniedRegistry, 'note.draft', 1, 'operator_http')?.operation;
    if (!deniedBuilder || !deniedCompiled) throw new TypeError('missing denied-audit fixture');
    const built = await deniedBuilder.build({
      operationName: 'note.draft',
      operationVersion: 1,
      surface: 'operator_http',
      correlationId: correlationIds[0],
      businessInput: { value: 'alpha', mode: 'success', workspace: 'workspace-alpha' },
      verifiedEvidence: {
        kind: 'operator',
        surface: 'operator_http',
        client: { key: 'web.test' },
        sessionHandle: 'ada:workspace-alpha'
      },
      rawIdempotencyKey: 'denied-audit-key'
    });
    if (built.kind !== 'outcome') throw new TypeError('expected denied context');
    const deniedResult: EffectfulOperationResult = {
      kind: 'outcome',
      outcome: built.outcome,
      terminal: false,
      correlationId: correlationIds[0]
    };
    expect(() => createContextDeniedOperationAuditRecord({
      attempt: built.auditAttempt,
      definition: deniedCompiled.definition,
      auditTarget: deniedCompiled.auditTarget,
      auditRecordProfile: deniedCompiled.auditRecordProfile,
      result: deniedResult
    })).not.toThrow();
    expect(() => createContextDeniedOperationAuditRecord({
      attempt: built.auditAttempt,
      definition: deniedCompiled.definition,
      auditTarget: deniedCompiled.auditTarget,
      auditRecordProfile: deniedCompiled.auditRecordProfile,
      result: {
        ...deniedResult,
        outcome: { ...built.outcome, detail: { forged: true } }
      }
    })).toThrow('invalid_operation_audit_context_denied_result');
  });

  test('rejects forged and wrong-context transaction authority seals before domain work', async () => {
    const forged = await harness();
    forged.port.authorityRecheckOverride = () => ({
      kind: 'sealed_effect_authority_recheck_result'
    } as SealedEffectAuthorityRecheckResult);
    await expect(forged.executor.execute(await sealed({ builder: forged.builder })))
      .rejects.toMatchObject({ phase: 'authority_recheck' });
    expect(forged.port.trace).toEqual([
      'replay_preflight', 'begin', 'authority_recheck', 'rollback'
    ]);
    expect(forged.observed.handlerCalls).toBe(0);
    expect(forged.port.domainCount).toBe(0);

    const wrongContext = await harness();
    await wrongContext.executor.execute(await sealed({
      builder: wrongContext.builder,
      rawKey: 'context-b-key',
      value: 'context-b'
    }));
    const contextB = wrongContext.observed.handlerContexts[0];
    if (!contextB) throw new TypeError('missing wrong-context authority fixture');
    const sealB = await recheckEffectInvocationCurrentAuthority(contextB);
    wrongContext.port.authorityRecheckOverride = () => sealB;
    const traceStart = wrongContext.port.trace.length;
    await expect(wrongContext.executor.execute(await sealed({
      builder: wrongContext.builder,
      rawKey: 'context-a-key',
      value: 'context-a'
    }))).rejects.toMatchObject({ phase: 'authority_recheck' });
    expect(wrongContext.port.trace.slice(traceStart)).toEqual([
      'replay_preflight', 'begin', 'authority_recheck', 'rollback'
    ]);
    expect(wrongContext.observed.handlerCalls).toBe(1);
    expect(wrongContext.port.domainCount).toBe(1);
  });

  test('a sealed invocation is single-use even when two executions overlap', async () => {
    const concurrent = await harness();
    const invocation = await sealed({ builder: concurrent.builder });
    const first = concurrent.executor.execute(invocation);
    await expect(concurrent.executor.execute(invocation))
      .rejects.toMatchObject({ phase: 'binding' });
    expect((await first).kind).toBe('success');
    expect(concurrent.observed.handlerCalls).toBe(1);
    expect(concurrent.port.domainCount).toBe(1);
    expect(concurrent.port.receiptCount).toBe(1);
  });

	test('an invocation cannot cross into an executor compiled from another registry', async () => {
		const first = await harness();
		const second = await harness();
		const invocation = await sealed({ builder: first.builder });

		await expect(second.executor.execute(invocation))
			.rejects.toMatchObject({ phase: 'binding' });
		expect(first.port.trace).toEqual([]);
		expect(second.port.trace).toEqual([]);
		expect(first.observed.handlerCalls).toBe(0);
		expect(second.observed.handlerCalls).toBe(0);

		expect((await first.executor.execute(invocation)).kind).toBe('success');
		expect(first.observed.handlerCalls).toBe(1);
		expect(second.observed.handlerCalls).toBe(0);
	});
});

describe('direct audited effect executor', () => {
  test('admits the compact profile only for commit operations', async () => {
    await expect(createOperationRegistry(fixture({ directAudited: true })))
      .rejects.toMatchObject({
        issues: [expect.objectContaining({ code: 'invalid_effect_execution_contract' })]
      });
  });

  test('writes one domain contribution and log, rechecks authority before replay, and conflicts changed requests', async () => {
    const direct = await harness({
      effect: 'commit', handlerEffect: 'commit', directAudited: true
    });
    const first = await direct.executor.execute(await sealed({
      builder: direct.builder, effect: 'commit', rawKey: 'direct-key', value: 'alpha'
    }));
    expect(first).toMatchObject({
      kind: 'success', data: { value: 'alpha' },
      receipt: { operationName: 'note.commit', operationVersion: 1 }
    });
    expect(direct.port.domainCount).toBe(1);
    expect(direct.port.directLogCount).toBe(1);
    expect(direct.port.directLogSummaries).toEqual(['Committed synthetic note']);
    expect(direct.port.childCount).toBe(0);
    expect(direct.port.trace).toEqual([
      'direct_log_preflight', 'direct_begin', 'authority_recheck', 'direct_log_recheck',
      'snapshot', 'domain', 'direct_log', 'direct_commit'
    ]);
    const authorityAfterFirst = direct.observed.authorityCalls;

    const replay = await direct.executor.execute(await sealed({
      builder: direct.builder, effect: 'commit', rawKey: 'direct-key', value: 'alpha'
    }));
    expect(replay).toEqual(first);
    expect(direct.observed.authorityCalls - authorityAfterFirst).toBe(2);
    expect(direct.port.domainCount).toBe(1);
    expect(direct.port.directLogCount).toBe(1);

    const changed = await direct.executor.execute(await sealed({
      builder: direct.builder, effect: 'commit', rawKey: 'direct-key', value: 'changed'
    }));
    expect(changed).toMatchObject({
      kind: 'outcome', terminal: false,
      outcome: { class: 'idempotency_conflict', kind: 'operation.request_changed' }
    });
    expect(direct.port.domainCount).toBe(1);
    expect(direct.port.directLogCount).toBe(1);
  });

  test('commits one versioned feature contribution atomically after the operation log', async () => {
    const direct = await harness({
      effect: 'commit', handlerEffect: 'commit', directAudited: true,
      directFeatureContributor: {
        reference: { key: 'feature.airtable.projection-impact', version: 1 },
        contribute: ({ operation, canonicalResult, scope, occurredAt }) => ({
          schemaVersion: 1,
          operation,
          canonicalResult,
          workspaceId: scope.workspaceId,
          occurredAt
        })
      }
    });
    const result = await direct.executor.execute(await sealed({
      builder: direct.builder, effect: 'commit', rawKey: 'feature-key', value: 'alpha'
    }));
    expect(result.kind).toBe('success');
    expect(direct.port.trace).toEqual([
      'direct_log_preflight', 'direct_begin', 'authority_recheck', 'direct_log_recheck',
      'snapshot', 'domain', 'direct_log', 'feature_contribution', 'direct_commit'
    ]);
    expect(direct.port.storedFeatureContributions).toEqual([expect.objectContaining({
      contributor: { key: 'feature.airtable.projection-impact', version: 1 },
      operationLogId: receiptIds[0],
      value: expect.objectContaining({
        schemaVersion: 1,
        operation: { name: 'note.commit', version: 1 }
      })
    })]);
  });

  test('commits Airtable then calendar as distinct contributions in frozen reference order', async () => {
    const direct = await harness({
      effect: 'commit', handlerEffect: 'commit', directAudited: true,
      directFeatureContributors: [
        {
          reference: { key: 'feature.calendar.commitment-facts', version: 1 },
          contribute: () => ({ schemaVersion: 1, facts: [{ kind: 'session_changed' }] })
        },
        {
          reference: { key: 'feature.airtable.projection-impact', version: 1 },
          contribute: () => ({ schemaVersion: 2, impacts: [] })
        }
      ]
    });
    expect((await direct.executor.execute(await sealed({
      builder: direct.builder, effect: 'commit', rawKey: 'composite-feature-key', value: 'alpha'
    })))).toMatchObject({ kind: 'success' });
    expect(direct.port.trace).toEqual([
      'direct_log_preflight', 'direct_begin', 'authority_recheck', 'direct_log_recheck',
      'snapshot', 'domain', 'direct_log',
      'feature_contribution', 'feature_contribution', 'direct_commit'
    ]);
    expect(direct.port.storedFeatureContributions.map((item) => item.contributor)).toEqual([
      { key: 'feature.airtable.projection-impact', version: 1 },
      { key: 'feature.calendar.commitment-facts', version: 1 }
    ]);
    expect(new Set(direct.port.storedFeatureContributions.map((item) => item.operationLogId)))
      .toEqual(new Set([receiptIds[0]]));
  });

  test('rolls back the domain, log, Airtable, and calendar contributions together', async () => {
    const direct = await harness({
      effect: 'commit', handlerEffect: 'commit', directAudited: true, failure: 'commit',
      directFeatureContributors: [
        {
          reference: { key: 'feature.airtable.projection-impact', version: 1 },
          contribute: () => ({ schemaVersion: 2, impacts: [] })
        },
        {
          reference: { key: 'feature.calendar.commitment-facts', version: 1 },
          contribute: () => ({ schemaVersion: 1, facts: [] })
        }
      ]
    });
    await expect(direct.executor.execute(await sealed({
      builder: direct.builder, effect: 'commit', rawKey: 'composite-rollback-key', value: 'alpha'
    }))).rejects.toMatchObject({ phase: 'unit_of_work' });
    expect(direct.port.domainCount).toBe(0);
    expect(direct.port.directLogCount).toBe(0);
    expect(direct.port.storedFeatureContributions).toEqual([]);
    expect(direct.port.trace.slice(-3)).toEqual([
      'feature_contribution', 'feature_contribution', 'direct_rollback'
    ]);
  });

  test('resolves a safe history summary from the committed action and rolls back an unmapped action', async () => {
    const mapped = await harness({
      effect: 'commit', handlerEffect: 'commit', directAudited: true,
      directAction: 'create', directSummariesByAction: { create: 'Created a synthetic note' }
    });
    expect((await mapped.executor.execute(await sealed({
      builder: mapped.builder, effect: 'commit', rawKey: 'mapped-key', value: 'alpha'
    }))).kind).toBe('success');
    expect(mapped.port.directLogSummaries).toEqual(['Created a synthetic note']);

    const unmapped = await harness({
      effect: 'commit', handlerEffect: 'commit', directAudited: true,
      directAction: 'update', directSummariesByAction: { create: 'Created a synthetic note' }
    });
    await expect(unmapped.executor.execute(await sealed({
      builder: unmapped.builder, effect: 'commit', rawKey: 'unmapped-key', value: 'alpha'
    }))).rejects.toMatchObject({ phase: 'canonical_result' });
    expect(unmapped.port.domainCount).toBe(0);
    expect(unmapped.port.directLogCount).toBe(0);
    expect(unmapped.port.trace.at(-1)).toBe('direct_rollback');
  });

  test('partitions replay by principal and scope and writes no log for a nonterminal outcome', async () => {
    const direct = await harness({
      effect: 'commit', handlerEffect: 'commit', directAudited: true
    });
    for (const candidate of [
      { principal: 'ada', scope: 'workspace-alpha' },
      { principal: 'grace', scope: 'workspace-alpha' },
      { principal: 'ada', scope: 'workspace-beta' }
    ]) {
      expect((await direct.executor.execute(await sealed({
        builder: direct.builder,
        effect: 'commit', rawKey: 'partitioned-key', value: candidate.scope,
        ...candidate
      }))).kind).toBe('success');
    }
    expect(direct.port.domainCount).toBe(3);
    expect(direct.port.directLogCount).toBe(3);

    const beforeAuthority = direct.observed.authorityCalls;
    const nonterminal = await direct.executor.execute(await sealed({
      builder: direct.builder,
      effect: 'commit', rawKey: 'nonterminal-key', value: 'none', mode: 'nonterminal'
    }));
    expect(nonterminal).toMatchObject({
      kind: 'outcome', terminal: false,
      outcome: { class: 'access_denied', kind: 'authority.denied' }
    });
    expect(direct.observed.authorityCalls - beforeAuthority).toBe(3);
    expect(direct.port.domainCount).toBe(3);
    expect(direct.port.directLogCount).toBe(3);
  });

  test('rolls back without a domain write or log when result projection fails', async () => {
    const direct = await harness({
      effect: 'commit', handlerEffect: 'commit', directAudited: true,
      semanticRewriteProjection: true
    });

    await expect(direct.executor.execute(await sealed({
      builder: direct.builder, effect: 'commit', rawKey: 'projection-key', value: 'alpha'
    }))).rejects.toMatchObject({ phase: 'projection' });
    expect(direct.port.domainCount).toBe(0);
    expect(direct.port.directLogCount).toBe(0);
    expect(direct.port.trace.at(-1)).toBe('direct_rollback');
  });
});

test('effect safe manifest contains only JSON contract metadata', async () => {
  const registry = await createOperationRegistry(fixture());
  const serialized = JSON.stringify(registry.safeManifest);
  expect(registry.safeManifest.operations[0]?.effect).toBe('draft');
  expect(registry.safeManifest.operations[0]?.autonomy).toMatchObject({
    policy: refs.autonomy,
    riskFloor: 'normal',
    requiresSeparateApproval: false,
    triggerDispositions: { ambiguous_external_effect: 'reconcile' }
  });
  expect(registry.safeManifest.operations[0]?.idempotency).toEqual({
    required: true,
    keySource: refs.keySource,
    credentialVerifierProfile: keyProfile,
    requestHashProfile: refs.requestHash
  });
  expect(serialized).not.toContain(refs.context.key);
  expect(serialized).not.toContain(refs.capability.key);
  expect(serialized).not.toContain(refs.handler.key);
  expect(serialized).not.toContain(refs.projection.key);
  expect(serialized).not.toContain(refs.contribution.key);
  expect(serialized).not.toContain(refs.audit.key);
  expect(serialized).not.toContain(refs.auditRecordProfile.key);
  expect(serialized).not.toContain('canonical_json');
  expect(serialized).not.toContain(operatorLane.policy.key);
  expect(serialized).not.toContain('raw-secret-key');
  expect(serialized).not.toContain('principal.ada');
  expect(serialized).not.toContain('runtimeEvaluator');
  expect(serialized).not.toContain('accessLanes');
  expect(registry.internalManifest.operationRegistryDigestSha256).toBe(registry.manifestDigestSha256);
  expect(registry.internalManifestDigestSha256).toBe(await sha256(canonicalJsonText(registry.internalManifest)));
});
