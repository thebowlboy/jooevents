import { describe, expect, test } from 'bun:test';
import {
  createEffectfulOperationResultSchema,
  createReadOperationResultSchema,
  structuredOutcomeSchema,
  type SafeSchemaManifestRef,
  type StructuredOutcome,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import {
  parseOperationAccessLane,
  type CurrentAuthorityDenialReason,
  type CurrentAuthorityResolver,
  type OperationAccessLane
} from '@jooevents/identity-access';
import {
  parseAgentRunId,
  parseCapabilityRevisionId,
  parseCeremonyEvidenceId,
  parseConsumerAttemptId,
  parseConsumerDeliveryId,
  parseContractVersion,
  parseEventId,
  parseIntegrationInboxReceiptId,
  parseInvocationId,
  parseInstant,
  parseJobId,
  parseMembershipId,
  parseModelAttemptId,
  parseModelToolCallId,
  parseParticipantSessionId,
  parsePublicPolicyRevisionId,
  parseUserId,
  parseVerifiedEnvelopeHandleId,
  parseWorkspaceId,
  type ResolvedScope
} from '@jooevents/kernel';
import { z } from 'zod';
import { createOperationAutonomyPolicy } from '../autonomy';
import { isSealedOperationAuditRecord } from './audit';
import { createEffectInvocationBuilder, createEffectOperationExecutor } from './effect-executor';
import { createReadOperationExecutor, OperationExecutionError, OperationInputError } from './executor';
import {
  InvocationContextError,
  consumeEffectInvocationCurrentAuthorityRecheck,
  createEffectInvocationContextBuilder,
  createHmacIdempotencyCredentialSealer,
  recheckEffectInvocationCurrentAuthority,
  createHmacRequestHashSealer,
  createReadInvocationContextBuilder,
  getTrustedInvocationBuilderBinding,
  isSealedInvocationContext,
  parseInvocationEvidence,
  type InvocationContext,
  type InvocationEvidence
} from './invocation-context';
import { createOperationRegistry } from './registry';
import { createSingleUnitOfWorkConformanceFixture } from './phase-autonomy-fixture';
import type {
  EffectOperationIdentity,
  EffectUnitOfWork,
  EffectUnitOfWorkPort,
  OperationAuditRecord,
  OperationRegistrySource,
  ShortOperationAuditRecord,
  TerminalEffectReceipt
} from './types';

const ids = {
  workspace: parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000'),
  otherWorkspace: parseWorkspaceId('550e8400-e29b-41d4-a716-446655440001'),
  event: parseEventId('01890f47-9abc-7def-8123-456789abc001'),
  user: parseUserId('01890f47-9abc-7def-8123-456789abc002'),
  membership: parseMembershipId('01890f47-9abc-7def-8123-456789abc003'),
  invocation: parseInvocationId('01890f47-9abc-7def-8123-456789abc004'),
  participantSession: parseParticipantSessionId('01890f47-9abc-7def-8123-456789abc005'),
  ceremony: parseCeremonyEvidenceId('01890f47-9abc-7def-8123-456789abc006'),
  agentRun: parseAgentRunId('01890f47-9abc-7def-8123-456789abc007'),
  modelAttempt: parseModelAttemptId('01890f47-9abc-7def-8123-456789abc008'),
  modelToolCall: parseModelToolCallId('01890f47-9abc-7def-8123-456789abc009'),
  job: parseJobId('01890f47-9abc-7def-8123-456789abc010'),
  delivery: parseConsumerDeliveryId('01890f47-9abc-7def-8123-456789abc011'),
  attempt: parseConsumerAttemptId('01890f47-9abc-7def-8123-456789abc012'),
  capability: parseCapabilityRevisionId('01890f47-9abc-7def-8123-456789abc013'),
  envelope: parseVerifiedEnvelopeHandleId('01890f47-9abc-7def-8123-456789abc014'),
  inbox: parseIntegrationInboxReceiptId('01890f47-9abc-7def-8123-456789abc015'),
  publicPolicy: parsePublicPolicyRevisionId('01890f47-9abc-7def-8123-456789abc016')
} as const;

const correlationId = '018f0f47-7a86-7d36-8a25-9f86589c7a4d';
const receiptId = '018f0f47-7a86-7d36-8a25-9f86589c7b40';
const now = parseInstant('2026-08-11T00:00:00.000Z');

function definitionRef(key: string): VersionedDefinitionRef {
  return { key, version: 1 };
}

function schemaRef(key: string, seed: string): SafeSchemaManifestRef {
  return { key, version: 1, digestSha256: seed.repeat(64) };
}

function lane(kind: OperationAccessLane['kind']): OperationAccessLane {
  const surfaces = {
    operator: 'operator_http',
    participant: 'participant_http',
    public_open: 'public_http',
    public_ceremony: 'public_http',
    external_mcp: 'external_mcp',
    app_model: 'app_model',
    registered_job: 'application_job',
    registered_consumer: 'application_job',
    registered_scheduler: 'application_job',
    verified_intake: 'provider_ingress',
    verified_inbox: 'provider_ingress'
  } as const;
  return parseOperationAccessLane({
    kind,
    surface: surfaces[kind],
    policy: { key: `authority.${kind}`, version: 1 }
  });
}

const operatorEvidence: InvocationEvidence = {
  kind: 'operator',
  surface: 'operator_http',
  client: { key: 'web.test', version: '1' },
  sessionHandle: 'session-super-secret'
};

function scope(workspaceId = ids.workspace): ResolvedScope {
  return {
    workspaceId,
    subjects: [{ kind: 'workspace', id: workspaceId }],
    resolutionEvidenceIds: ['workspace-target:v1']
  };
}

function authorityOutcome(reason: CurrentAuthorityDenialReason): StructuredOutcome {
  return {
    class: 'access_denied',
    kind: `authority.${reason}`,
    retryable: false,
    subjects: [],
    detail: null,
    detailSchemaVersion: 1
  };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Bytes(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(value).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const profile = { key: 'invocation.test', version: parseContractVersion(1) } as const;
const rotatedProfile = { key: 'invocation.test', version: parseContractVersion(2) } as const;

type AuthorityMode = 'current' | 'stale' | 'revoked' | 'cross_scope';

function operatorAuthorityResolver(mode: AuthorityMode): CurrentAuthorityResolver<InvocationEvidence> {
  return {
    resolve(input) {
      if (mode === 'stale' || mode === 'revoked') return { kind: 'denied', reason: mode };
      return {
        kind: 'authorized',
        authority: {
          actor: { kind: 'workspace_user', userId: ids.user },
          principal: { kind: 'workspace_user', userId: ids.user, membershipId: ids.membership },
          lane: input.lane,
          scope: mode === 'cross_scope' ? scope(ids.otherWorkspace) : input.scope,
          grants: [{ kind: 'permission', key: 'test.secure.read' }],
          evidenceIds: ['membership-current:v1'],
          authorityCitationIds: [],
          evaluatedAt: input.evaluatedAt
        }
      };
    }
  };
}

const refs = {
  input: schemaRef('schema.secure.input', '1'),
  readCanonical: schemaRef('schema.secure-read.canonical', '2'),
  readProjected: schemaRef('schema.secure-read.operator-result', '3'),
  effectCanonical: schemaRef('schema.secure-draft.canonical', '4'),
  effectContribution: schemaRef('schema.secure-draft.contribution', '5'),
  effectProjected: schemaRef('schema.secure-draft.operator-result', '6'),
  denialDetail: schemaRef('schema.authority-denial.detail', '7'),
  readContext: definitionRef('context.secure-read'),
  effectContext: definitionRef('context.secure-draft'),
  readAutonomy: definitionRef('autonomy.secure-read'),
  effectAutonomy: definitionRef('autonomy.secure-draft'),
  readCapability: definitionRef('capability.secure-read'),
  effectCapability: definitionRef('capability.secure-write'),
  readHandler: definitionRef('handler.secure-read'),
  effectHandler: definitionRef('handler.secure-draft'),
  readProjection: definitionRef('projection.secure-read-operator'),
  effectProjection: definitionRef('projection.secure-draft-operator'),
  keySource: definitionRef('idempotency.operator-header'),
  requestHash: definitionRef('request-hash.trusted-invocation'),
  concurrency: definitionRef('concurrency.secure-draft'),
  readTrace: definitionRef('trace.secure-read'),
  audit: definitionRef('audit.secure-draft'),
  auditRecordProfile: definitionRef('audit-record.canonical-json')
} as const;

const inputSchema = z.object({ value: z.string().min(1) });
const readCanonicalSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: z.strictObject({ value: z.string(), internal: z.string() }) }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
const readProjectedSchema = createReadOperationResultSchema(z.strictObject({ value: z.string() }));
const effectCanonicalSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: z.strictObject({ value: z.string() }) }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
const effectContributionSchema = z.strictObject({
  result: effectCanonicalSchema,
  domain: z.strictObject({ value: z.string() }),
  receiptChildren: z.array(z.strictObject({ kind: z.literal('domain_evidence'), value: z.string() }))
});
const effectProjectedSchema = createEffectfulOperationResultSchema(z.strictObject({ value: z.string() }));

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

class MemoryUnitOfWork implements EffectUnitOfWorkPort {
  readonly receipts = new Map<string, TerminalEffectReceipt>();
  readonly audits: OperationAuditRecord[] = [];

  findTerminalReceipt(identity: EffectOperationIdentity) {
    return this.receipts.get(identityKey(identity));
  }

  recordShortOperationAudit(record: ShortOperationAuditRecord) {
    if (!isSealedOperationAuditRecord(record)) throw new TypeError('unsealed audit');
    this.audits.push(record);
  }

  async runInUnitOfWork<Value>(work: (unitOfWork: EffectUnitOfWork) => Promise<Value>): Promise<Value> {
    const receipts = this.receipts;
    return work({
      recheckCurrentAuthority: (context) => recheckEffectInvocationCurrentAuthority(context),
      acquireExecutionClaim: () => ({ kind: 'acquired' }),
      findTerminalReceipt: (identity) => receipts.get(identityKey(identity)),
      openHandlerSnapshot: () => ({ allowed: true }),
      applyDomainContribution: () => undefined,
      insertReceiptParent: (receipt) => { receipts.set(identityKey(receipt.identity), receipt); },
      insertTerminalNewOperationAudit: (record) => { this.audits.push(record); },
      insertReceiptChild: () => undefined,
      releaseExecutionClaim: () => undefined
    });
  }
}

async function operationHarness(
  mode: AuthorityMode = 'current',
  credentialSealProfile = profile,
  requestHashSealer = createHmacRequestHashSealer({
    profile: refs.requestHash,
    keyBytes: new Uint8Array(32).fill(0x32)
  })
) {
  const contexts: InvocationContext[] = [];
  const sealedKeys: string[] = [];
  let readHandlerCalls = 0;
  let effectHandlerCalls = 0;
  const common = {
    lanes: [lane('operator')],
    scopeResolver: { resolve: () => scope() },
    authorityResolver: operatorAuthorityResolver(mode),
    clock: { now: () => now },
    newInvocationId: () => ids.invocation,
    authorityPrincipalKeyProfile: profile,
    scopePartitionProfile: profile,
    requestCanonicalizationProfile: profile,
    deniedAuthorityOutcome: authorityOutcome
  } as const;
  const readContext = createReadInvocationContextBuilder({
    ...common,
    reference: refs.readContext,
    operation: { name: 'secure.read', version: 1 },
    effect: 'read'
  });
  const effectContext = createEffectInvocationContextBuilder({
    ...common,
    reference: refs.effectContext,
    operation: { name: 'secure.draft', version: 1 },
    effect: 'draft',
    requestHashProfile: refs.requestHash,
    requestHashSealer,
    idempotencyCredentialProfile: profile,
    idempotencyCredentialSealer: {
      async seal(rawIdempotencyKey) {
        sealedKeys.push(rawIdempotencyKey);
        return { verifierProfile: credentialSealProfile, verifierSha256: await sha256(`server-secret:${rawIdempotencyKey}`) };
      }
    }
  });
  const accessOutcomes = ['missing', 'not_authorized', 'stale', 'revoked', 'cross_scope', 'lane_mismatch'].map((reason) => ({
    class: 'access_denied' as const,
    kind: `authority.${reason}`,
    retryable: false,
    detailSchema: refs.denialDetail
  }));
  const autonomyPolicy = (
    name: string,
    definition: VersionedDefinitionRef,
    riskFloor: 'low' | 'normal'
  ) => createOperationAutonomyPolicy({
    definition,
    operation: { name, version: 1 },
    riskFloor,
    unattendedRiskCeiling: riskFloor,
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
  const readPolicy = autonomyPolicy('secure.read', refs.readAutonomy, 'low');
  const effectPolicy = autonomyPolicy('secure.draft', refs.effectAutonomy, 'normal');
  const phaseControl = createSingleUnitOfWorkConformanceFixture({
    operation: { name: 'secure.draft', version: 1, effect: 'draft' },
    maximumRisk: 'normal',
    consequenceTags: [],
    autonomyPolicy: effectPolicy,
    handler: refs.effectHandler,
    handlerCapability: refs.effectCapability,
    contributionSchema: refs.effectContribution,
    nullDetailSchema: refs.denialDetail
  });
  const source: OperationRegistrySource = {
    ...phaseControl.registrations,
    autonomyPolicies: [readPolicy, effectPolicy],
    schemas: [
      { reference: refs.input, schema: inputSchema },
      { reference: refs.readCanonical, schema: readCanonicalSchema },
      { reference: refs.readProjected, schema: readProjectedSchema },
      { reference: refs.effectCanonical, schema: effectCanonicalSchema },
      { reference: refs.effectContribution, schema: effectContributionSchema },
      { reference: refs.effectProjected, schema: effectProjectedSchema },
      { reference: refs.denialDetail, schema: z.null() }
    ],
    contextBuilders: [readContext],
    readCapabilities: [{ reference: refs.readCapability, openSnapshot: () => ({ value: 'server-value' }) }],
    handlers: [{
      reference: refs.readHandler,
      readCapability: refs.readCapability,
      canonicalResultSchema: refs.readCanonical,
      handle: ({ context, snapshot }) => {
        readHandlerCalls += 1;
        expect(isSealedInvocationContext(context)).toBe(true);
        contexts.push(context as InvocationContext);
        return { kind: 'success', data: { value: String(snapshot.value), internal: 'private' } };
      }
    }],
    projections: [
      {
        reference: refs.readProjection,
        canonicalResultSchema: refs.readCanonical,
        projectedResultSchema: refs.readProjected,
        project: (candidate) => {
          const parsed = readCanonicalSchema.parse(candidate);
          return parsed.kind === 'success'
            ? { kind: 'success', data: { value: parsed.data.value } }
            : parsed;
        }
      },
      {
        reference: refs.effectProjection,
        canonicalResultSchema: refs.effectCanonical,
        projectedResultSchema: refs.effectProjected,
        project: (candidate) => effectCanonicalSchema.parse(candidate)
      }
    ],
    operations: [{
      name: 'secure.read',
      version: 1,
      lifecycle: { status: 'active' },
      summary: 'Read through current trusted authority.',
      effect: 'read',
      maxRisk: 'low',
      autonomyPolicy: refs.readAutonomy,
      consequenceTags: ['disclosure'],
      inputSchema: refs.input,
      canonicalResultSchema: refs.readCanonical,
      outcomes: accessOutcomes,
      accessLanes: common.lanes,
      contextBuilder: refs.readContext,
      readCapability: refs.readCapability,
      handler: refs.readHandler,
      observability: {
        trace: { mode: 'required', target: refs.readTrace },
        immutableAudit: { mode: 'none' }
      },
      bindings: [{
        surface: 'operator_http',
        method: 'GET',
        path: '/api/test/secure-read',
        input: 'query',
        browserResumption: { kind: 'none' },
        projection: refs.readProjection
      }]
    }],
    effectContextBuilders: [effectContext],
    readOperationalTraceTargets: [{
      reference: refs.readTrace,
      kind: 'read_operational_trace_record',
      recordProfile: refs.auditRecordProfile
    }],
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
      reference: refs.effectHandler,
      effect: 'draft',
      handlerCapability: refs.effectCapability,
      contributionSchema: refs.effectContribution,
      canonicalResultSchema: refs.effectCanonical,
      handle: ({ businessInput, context }) => {
        effectHandlerCalls += 1;
        expect(isSealedInvocationContext(context)).toBe(true);
        contexts.push(context as InvocationContext);
        const parsed = inputSchema.parse(businessInput);
        return {
          result: { kind: 'success', data: { value: parsed.value } },
          domain: { value: parsed.value },
          receiptChildren: [{ kind: 'domain_evidence', value: parsed.value }]
        };
      }
    }],
    effectOperations: [{
      name: 'secure.draft',
      version: 1,
      lifecycle: { status: 'active' },
      summary: 'Draft through current trusted authority.',
      effect: 'draft',
      maxRisk: 'normal',
      autonomyPolicy: refs.effectAutonomy,
      consequenceTags: [],
      inputSchema: refs.input,
      contributionSchema: refs.effectContribution,
      canonicalResultSchema: refs.effectCanonical,
      outcomes: [
        ...accessOutcomes,
        { class: 'idempotency_conflict', kind: 'operation.request_changed', retryable: false, detailSchema: refs.denialDetail },
        phaseControl.contentionOutcomeDeclaration,
        ...phaseControl.outcomeDeclarations
      ],
      accessLanes: common.lanes,
      contextBuilder: refs.effectContext,
      handlerCapability: refs.effectCapability,
      handler: refs.effectHandler,
      audit: { mode: 'required', target: refs.audit },
      idempotency: {
        keySource: refs.keySource,
        credentialVerifierProfile: profile,
        requestHashProfile: refs.requestHash
      },
      concurrency: refs.concurrency,
      execution: phaseControl.execution,
      bindings: [{
        surface: 'operator_http',
        method: 'POST',
        path: '/api/test/secure-drafts',
        input: 'body',
        browserResumption: { kind: 'none' },
        projection: refs.effectProjection
      }]
    }]
  };
  const registry = await createOperationRegistry(source);
  return {
    registry,
    contexts,
    sealedKeys,
    get readHandlerCalls() { return readHandlerCalls; },
    get effectHandlerCalls() { return effectHandlerCalls; }
  };
}

const readObservationOptions = {
  operationalTrace: { emit: () => undefined },
  immutableAudit: { append: () => undefined },
  clock: { now: () => now },
  newInvocationId: () => ids.invocation
} as const;

describe('closed invocation evidence', () => {
  test('accepts every closed verified protocol branch and rejects generic bags', () => {
    const client = { key: 'runtime.test' };
    const evidence: readonly InvocationEvidence[] = [
      operatorEvidence,
      { kind: 'participant', surface: 'participant_http', client, participantSessionId: ids.participantSession },
      { kind: 'public_open', surface: 'public_http', client, publicPolicyRevisionId: ids.publicPolicy },
      { kind: 'public_ceremony', surface: 'public_http', client, ceremonyEvidenceId: ids.ceremony },
      { kind: 'external_mcp', surface: 'external_mcp', client, oauthTokenHandle: 'token-handle', oauthClientId: 'client-id' },
      { kind: 'app_model', surface: 'app_model', client, agentRunId: ids.agentRun, modelAttemptId: ids.modelAttempt, modelToolCallId: ids.modelToolCall },
      { kind: 'registered_job', surface: 'application_job', client, jobId: ids.job },
      { kind: 'registered_consumer', surface: 'application_job', client, consumerDeliveryId: ids.delivery, consumerAttemptId: ids.attempt },
      { kind: 'registered_scheduler', surface: 'application_job', client, schedulerKey: 'due-work', schedulerVersion: parseContractVersion(1), capabilityRevisionId: ids.capability },
      { kind: 'verified_intake', surface: 'provider_ingress', client, verifiedEnvelopeHandleId: ids.envelope },
      { kind: 'verified_inbox', surface: 'provider_ingress', client, inboxReceiptId: ids.inbox }
    ];

    expect(evidence.map((candidate) => parseInvocationEvidence(candidate).kind)).toEqual([
      'operator', 'participant', 'public_open', 'public_ceremony', 'external_mcp', 'app_model',
      'registered_job', 'registered_consumer', 'registered_scheduler', 'verified_intake', 'verified_inbox'
    ]);
    expect(() => parseInvocationEvidence({
      ...operatorEvidence,
      actor: { kind: 'workspace_user', userId: ids.user }
    })).toThrow(InvocationContextError);
    expect(() => parseInvocationEvidence({
      kind: 'machine', surface: 'application_job', client, id: ids.job
    })).toThrow(InvocationContextError);
  });
});

describe('trusted operation invocation', () => {
  test('scope resolution receives no session, OAuth, or transport-client material', async () => {
    const observed: unknown[] = [];
    const registration = createReadInvocationContextBuilder({
      reference: definitionRef('context.credential-free-scope'),
      operation: { name: 'credential-free-scope.read', version: 1 },
      effect: 'read',
      lanes: [lane('operator'), lane('external_mcp')],
      scopeResolver: {
        resolve(input) {
          observed.push(input.evidence);
          return scope();
        }
      },
      authorityResolver: {
        resolve: () => ({ kind: 'denied', reason: 'not_authorized' })
      },
      clock: { now: () => now },
      newInvocationId: () => ids.invocation,
      authorityPrincipalKeyProfile: profile,
      scopePartitionProfile: profile,
      requestCanonicalizationProfile: profile,
      deniedAuthorityOutcome: authorityOutcome
    });

    await registration.build({
      operationName: 'credential-free-scope.read',
      operationVersion: 1,
      surface: 'operator_http',
      correlationId,
      businessInput: { value: 'operator target' },
      verifiedEvidence: operatorEvidence
    });
    await registration.build({
      operationName: 'credential-free-scope.read',
      operationVersion: 1,
      surface: 'external_mcp',
      correlationId,
      businessInput: { value: 'mcp target' },
      verifiedEvidence: {
        kind: 'external_mcp',
        surface: 'external_mcp',
        client: { key: 'secret-client-shape' },
        oauthTokenHandle: 'oauth-token-super-secret',
        oauthClientId: 'oauth-client-secret-canary'
      }
    });

    expect(observed).toEqual([
      { kind: 'operator', surface: 'operator_http' },
      { kind: 'external_mcp', surface: 'external_mcp' }
    ]);
    const serialized = JSON.stringify(observed);
    expect(serialized).not.toContain(operatorEvidence.sessionHandle);
    expect(serialized).not.toContain('oauth-token-super-secret');
    expect(serialized).not.toContain('oauth-client-secret-canary');
    expect(serialized).not.toContain('secret-client-shape');
  });

  test('builder registration captures an immutable exact operation and lane binding', () => {
    const mutableOperation = { name: 'immutable.read', version: 1 };
    const mutableLanes = [lane('operator')];
    const registration = createReadInvocationContextBuilder({
      reference: definitionRef('context.immutable-read'),
      operation: mutableOperation,
      effect: 'read',
      lanes: mutableLanes,
      scopeResolver: { resolve: () => scope() },
      authorityResolver: operatorAuthorityResolver('current'),
      clock: { now: () => now },
      newInvocationId: () => ids.invocation,
      authorityPrincipalKeyProfile: profile,
      scopePartitionProfile: profile,
      requestCanonicalizationProfile: profile,
      deniedAuthorityOutcome: authorityOutcome
    });
    mutableOperation.name = 'substituted.read';
    mutableLanes.push(lane('participant'));

    const binding = getTrustedInvocationBuilderBinding(registration);
    expect(binding).toEqual({
      operation: { name: 'immutable.read', version: 1, effect: 'read' },
      accessLanes: [lane('operator')]
    });
    expect(Object.isFrozen(binding)).toBe(true);
    expect(Object.isFrozen(binding?.operation)).toBe(true);
    expect(Object.isFrozen(binding?.accessLanes)).toBe(true);
    expect(getTrustedInvocationBuilderBinding({ reference: registration.reference, build: registration.build })).toBeUndefined();
  });

  test('ordinary read and draft execution receive only opaque sealed context', async () => {
    const harness = await operationHarness();
    const read = await createReadOperationExecutor(harness.registry, readObservationOptions).execute({
      operationName: 'secure.read',
      operationVersion: 1,
      surface: 'operator_http',
      correlationId,
      businessInput: { value: 'read' },
      verifiedEvidence: operatorEvidence
    });
    expect(read.kind).toBe('success');

    const rawKey = 'raw-idempotency-secret';
    const invocation = await createEffectInvocationBuilder(harness.registry).build({
      operationName: 'secure.draft',
      operationVersion: 1,
      surface: 'operator_http',
      correlationId,
      businessInput: { value: 'draft' },
      verifiedEvidence: operatorEvidence,
      rawIdempotencyKey: rawKey
    });
    const effect = await createEffectOperationExecutor({
      registry: harness.registry,
      unitOfWork: new MemoryUnitOfWork(),
      newReceiptId: () => receiptId
    }).execute(invocation);
    expect(effect.kind).toBe('success');
    expect(harness.sealedKeys).toEqual([rawKey]);
    expect(harness.contexts).toHaveLength(2);
    for (const context of harness.contexts) {
      const serialized = JSON.stringify(context);
      expect(Object.isFrozen(context)).toBe(true);
      expect(serialized).not.toContain(operatorEvidence.sessionHandle);
      expect(serialized).not.toContain(rawKey);
      expect(serialized).not.toContain('oauthTokenHandle');
      expect(context.requestBinding.requestHashSha256).toMatch(/^[a-f0-9]{64}$/);
      if (context.operation.effect !== 'read') {
        expect(context.requestBinding.requestHashProfile).toEqual(refs.requestHash);
      }
    }
  });

  test('runtime credential-profile rotation fails before a sealed invocation exists', async () => {
    const harness = await operationHarness('current', rotatedProfile);

    await expect(createEffectInvocationBuilder(harness.registry).build({
      operationName: 'secure.draft',
      operationVersion: 1,
      surface: 'operator_http',
      correlationId,
      businessInput: { value: 'draft' },
      verifiedEvidence: operatorEvidence,
      rawIdempotencyKey: 'profile-rotation-must-fail-closed'
    })).rejects.toMatchObject({ phase: 'context' });

    expect(harness.effectHandlerCalls).toBe(0);
    expect(harness.sealedKeys).toEqual(['profile-rotation-must-fail-closed']);
  });

  test('set-valued current-authority evidence is canonical across order and duplicates', async () => {
    let resolution = 0;
    const authorityResolver: CurrentAuthorityResolver<InvocationEvidence> = {
      resolve(input) {
        resolution += 1;
        const initial = resolution === 1;
        return {
          kind: 'authorized',
          authority: {
            actor: { kind: 'workspace_user', userId: ids.user },
            principal: {
              kind: 'workspace_user',
              userId: ids.user,
              membershipId: ids.membership
            },
            lane: input.lane,
            scope: input.scope,
            grants: initial
              ? [
                  { kind: 'permission' as const, key: 'test.zeta' },
                  { kind: 'permission' as const, key: 'test.alpha' },
                  { kind: 'permission' as const, key: 'test.alpha' }
                ]
              : [
                  { kind: 'permission' as const, key: 'test.alpha' },
                  { kind: 'permission' as const, key: 'test.zeta' }
                ],
            evidenceIds: initial
              ? ['membership:zeta', 'membership:alpha', 'membership:alpha']
              : ['membership:alpha', 'membership:zeta'],
            authorityCitationIds: [],
            evaluatedAt: input.evaluatedAt
          }
        };
      }
    };
    const builder = createEffectInvocationContextBuilder({
      reference: definitionRef('context.canonical-authority'),
      operation: { name: 'canonical-authority.draft', version: 1 },
      effect: 'draft',
      lanes: [lane('operator')],
      scopeResolver: { resolve: () => scope() },
      authorityResolver,
      clock: { now: () => now },
      newInvocationId: () => ids.invocation,
      authorityPrincipalKeyProfile: profile,
      scopePartitionProfile: profile,
      requestCanonicalizationProfile: profile,
      requestHashProfile: refs.requestHash,
      requestHashSealer: createHmacRequestHashSealer({
        profile: refs.requestHash,
        keyBytes: new Uint8Array(32).fill(0x35)
      }),
      idempotencyCredentialProfile: profile,
      idempotencyCredentialSealer: {
        seal: async (raw) => ({
          verifierProfile: profile,
          verifierSha256: await sha256(raw)
        })
      },
      deniedAuthorityOutcome: authorityOutcome
    });
    const built = await builder.build({
      operationName: 'canonical-authority.draft',
      operationVersion: 1,
      surface: 'operator_http',
      correlationId,
      businessInput: { value: 'same' },
      verifiedEvidence: operatorEvidence,
      rawIdempotencyKey: 'canonical-authority'
    });
    expect(built.kind).toBe('ready');
    if (built.kind !== 'ready') throw new Error('expected ready invocation context');
    const context = built.context as InvocationContext;
    const recheck = await recheckEffectInvocationCurrentAuthority(context);
    expect(consumeEffectInvocationCurrentAuthorityRecheck(context, recheck)).toEqual({
      kind: 'authorized',
      evaluatedAt: now
    });
    expect(resolution).toBe(2);
  });

  test('request bindings are repeatable keyed seals and reject plain digests or runtime profile substitution', async () => {
    const bytes = new TextEncoder().encode('low-entropy-classified-request');
    const sealer = createHmacRequestHashSealer({
      profile: refs.requestHash,
      keyBytes: new Uint8Array(32).fill(0x44)
    });
    const first = await sealer.seal(bytes);
    const second = await sealer.seal(Uint8Array.from(bytes));
    expect(first).toEqual(second);
    expect(first.verifierProfile).toEqual(refs.requestHash);
    expect(first.verifierSha256).not.toBe(await sha256Bytes(bytes));

    const invalidSealers = [{
      seal: async (canonical: Uint8Array) => ({
        verifierProfile: refs.requestHash,
        verifierSha256: await sha256Bytes(canonical)
      })
    }, {
      seal: async () => ({
        verifierProfile: definitionRef('request-hash.substituted'),
        verifierSha256: 'b'.repeat(64)
      })
    }];
    for (const invalidSealer of invalidSealers) {
      const harness = await operationHarness('current', profile, invalidSealer);
      await expect(createEffectInvocationBuilder(harness.registry).build({
        operationName: 'secure.draft',
        operationVersion: 1,
        surface: 'operator_http',
        correlationId,
        businessInput: { value: 'sensitive-low-entropy' },
        verifiedEvidence: operatorEvidence,
        rawIdempotencyKey: 'request-seal-test'
      })).rejects.toMatchObject({ phase: 'context' });
      expect(harness.effectHandlerCalls).toBe(0);
      expect(harness.contexts).toHaveLength(0);
    }
  });

  test('idempotency credentials use a repeatable server-keyed verifier without retaining the raw key', async () => {
    const firstSecret = new Uint8Array(32).fill(0x51);
    const secondSecret = new Uint8Array(32).fill(0x52);
    const first = createHmacIdempotencyCredentialSealer({
      profile,
      keyBytes: firstSecret
    });
    const sameKey = await first.seal('browser-retry-key');

    expect(await first.seal('browser-retry-key')).toEqual(sameKey);
    expect(await first.seal('another-retry-key')).not.toEqual(sameKey);
    expect(await createHmacIdempotencyCredentialSealer({
      profile,
      keyBytes: secondSecret
    }).seal('browser-retry-key')).not.toEqual(sameKey);
    expect(sameKey.verifierProfile).toEqual(profile);
    expect(sameKey.verifierSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(sameKey)).not.toContain('browser-retry-key');
    expect(() => createHmacIdempotencyCredentialSealer({
      profile,
      keyBytes: new Uint8Array(31)
    })).toThrow(InvocationContextError);
    await expect(first.seal('')).rejects.toThrow(InvocationContextError);
    await expect(first.seal('x'.repeat(513))).rejects.toThrow(InvocationContextError);
  });

  test('actor, scope, and every structural approval claim fail before permissive schemas can strip them', async () => {
    const harness = await operationHarness();
    const executor = createReadOperationExecutor(harness.registry, readObservationOptions);
    for (const claimed of [
      { actor: { kind: 'workspace_user', userId: ids.user } },
      { scope: { workspaceId: ids.workspace } },
      { approval: { id: 'caller-selected' } },
      { renewedApproval: { id: 'caller-selected' } },
      { approverCurrentlyAuthorized: true },
      { consequentialApprovalSatisfied: true }
    ]) {
      await expect(executor.execute({
        operationName: 'secure.read',
        operationVersion: 1,
        surface: 'operator_http',
        correlationId,
        businessInput: { value: 'read', ...claimed },
        verifiedEvidence: operatorEvidence
      })).rejects.toBeInstanceOf(OperationInputError);
    }
    expect(harness.readHandlerCalls).toBe(0);
  });

  test('stale and revoked authority are nonterminal outcomes before handlers or receipt lookup', async () => {
    for (const mode of ['stale', 'revoked'] as const) {
      const harness = await operationHarness(mode);
      const result = await createReadOperationExecutor(harness.registry, readObservationOptions).execute({
        operationName: 'secure.read',
        operationVersion: 1,
        surface: 'operator_http',
        correlationId,
        businessInput: { value: 'read' },
        verifiedEvidence: operatorEvidence
      });
      expect(result.kind).toBe('outcome');
      if (result.kind === 'outcome') expect(result.outcome.kind).toBe(`authority.${mode}`);
      expect(harness.readHandlerCalls).toBe(0);
    }

    const revoked = await operationHarness('revoked');
    const invocation = await createEffectInvocationBuilder(revoked.registry).build({
      operationName: 'secure.draft',
      operationVersion: 1,
      surface: 'operator_http',
      correlationId,
      businessInput: { value: 'draft' },
      verifiedEvidence: operatorEvidence,
      rawIdempotencyKey: 'must-not-be-sealed-after-denial'
    });
    let receiptLookups = 0;
    const shortAudits: ShortOperationAuditRecord[] = [];
    const port: EffectUnitOfWorkPort = {
      findTerminalReceipt: () => { receiptLookups += 1; return undefined; },
      recordShortOperationAudit: (record) => { shortAudits.push(record); },
      runInUnitOfWork: async () => { throw new Error('unit of work must not open'); }
    };
    const denied = await createEffectOperationExecutor({ registry: revoked.registry, unitOfWork: port }).execute(invocation);
    expect(denied).toMatchObject({ kind: 'outcome', terminal: false, outcome: { kind: 'authority.revoked' } });
    expect(receiptLookups).toBe(0);
    expect(shortAudits).toHaveLength(1);
    expect(shortAudits[0]).toMatchObject({
      disposition: 'context_denied',
      denialReason: 'revoked',
      resultSummary: {
        kind: 'outcome',
        outcomeClass: 'access_denied',
        outcomeKind: 'authority.revoked',
        terminal: false
      }
    });
    expect(shortAudits[0] && 'receiptId' in shortAudits[0]).toBe(false);
    expect(shortAudits[0] && 'relatedReceiptId' in shortAudits[0]).toBe(false);
    expect(revoked.effectHandlerCalls).toBe(0);
    expect(revoked.sealedKeys).toEqual([]);
  });

  test('authorized results cannot substitute another resolved scope', async () => {
    const harness = await operationHarness('cross_scope');
    try {
      await createReadOperationExecutor(harness.registry, readObservationOptions).execute({
        operationName: 'secure.read',
        operationVersion: 1,
        surface: 'operator_http',
        correlationId,
        businessInput: { value: 'read' },
        verifiedEvidence: operatorEvidence
      });
      throw new Error('expected context failure');
    } catch (error) {
      expect(error).toBeInstanceOf(OperationExecutionError);
      expect((error as OperationExecutionError).phase).toBe('context');
      expect((error as OperationExecutionError).cause).toBeInstanceOf(InvocationContextError);
    }
  });

  test('surface and same-surface machine-lane substitution fail closed', async () => {
    const harness = await operationHarness();
    await expect(createReadOperationExecutor(harness.registry, readObservationOptions).execute({
      operationName: 'secure.read',
      operationVersion: 1,
      surface: 'operator_http',
      correlationId,
      businessInput: { value: 'read' },
      verifiedEvidence: {
        kind: 'external_mcp', surface: 'external_mcp', client: { key: 'mcp.test' },
        oauthTokenHandle: 'verified-token-handle', oauthClientId: 'client-id'
      }
    })).rejects.toBeInstanceOf(OperationExecutionError);

    const jobBuilder = createReadInvocationContextBuilder({
      reference: definitionRef('context.job-read'),
      operation: { name: 'job.read', version: 1 },
      effect: 'read',
      lanes: [lane('registered_job')],
      scopeResolver: { resolve: () => scope() },
      authorityResolver: operatorAuthorityResolver('current'),
      clock: { now: () => now },
      newInvocationId: () => ids.invocation,
      authorityPrincipalKeyProfile: profile,
      scopePartitionProfile: profile,
      requestCanonicalizationProfile: profile,
      deniedAuthorityOutcome: authorityOutcome
    });
    await expect(jobBuilder.build({
      operationName: 'job.read',
      operationVersion: 1,
      surface: 'application_job',
      correlationId,
      businessInput: { value: 'read' },
      verifiedEvidence: {
        kind: 'registered_consumer', surface: 'application_job', client: { key: 'worker.test' },
        consumerDeliveryId: ids.delivery, consumerAttemptId: ids.attempt
      }
    })).rejects.toMatchObject({ code: 'lane_substitution' });
  });

  test('lane identity partitions identical business requests without changing the delegated principal', async () => {
    const resolver: CurrentAuthorityResolver<InvocationEvidence> = {
      resolve(input) {
        const actor = input.evidence.kind === 'external_mcp'
          ? { kind: 'external_mcp_client' as const, oauthClientId: input.evidence.oauthClientId, authorityPrincipalId: 'principal-ref' }
          : input.evidence.kind === 'app_model'
            ? { kind: 'app_model_run' as const, agentRunId: input.evidence.agentRunId, delegatedByPrincipalId: 'principal-ref' }
            : undefined;
        if (!actor) return { kind: 'denied', reason: 'lane_mismatch' };
        return {
          kind: 'authorized',
          authority: {
            actor,
            principal: { kind: 'workspace_user', userId: ids.user, membershipId: ids.membership },
            lane: input.lane,
            scope: input.scope,
            grants: [{ kind: 'permission', key: 'test.secure.read' }],
            evidenceIds: ['delegation-current:v1'],
            authorityCitationIds: [],
            evaluatedAt: input.evaluatedAt
          }
        };
      }
    };
    const common = {
      reference: definitionRef('context.delegated-read'),
      operation: { name: 'delegated.read', version: 1 },
      effect: 'read' as const,
      scopeResolver: { resolve: () => scope() },
      authorityResolver: resolver,
      clock: { now: () => now },
      newInvocationId: () => ids.invocation,
      authorityPrincipalKeyProfile: profile,
      scopePartitionProfile: profile,
      requestCanonicalizationProfile: profile,
      deniedAuthorityOutcome: authorityOutcome
    };
    const mcpToken = 'opaque-mcp-token-handle';
    const mcp = await createReadInvocationContextBuilder({ ...common, lanes: [lane('external_mcp')] }).build({
      operationName: 'delegated.read', operationVersion: 1, surface: 'external_mcp', correlationId,
      businessInput: { value: 'same' },
      verifiedEvidence: { kind: 'external_mcp', surface: 'external_mcp', client: { key: 'mcp.test' }, oauthTokenHandle: mcpToken, oauthClientId: 'client-id' }
    });
    const model = await createReadInvocationContextBuilder({ ...common, lanes: [lane('app_model')] }).build({
      operationName: 'delegated.read', operationVersion: 1, surface: 'app_model', correlationId,
      businessInput: { value: 'same' },
      verifiedEvidence: { kind: 'app_model', surface: 'app_model', client: { key: 'model.test' }, agentRunId: ids.agentRun, modelAttemptId: ids.modelAttempt, modelToolCallId: ids.modelToolCall }
    });
    expect(mcp.kind).toBe('ready');
    expect(model.kind).toBe('ready');
    if (mcp.kind !== 'ready' || model.kind !== 'ready') throw new Error('expected contexts');
    const mcpContext = mcp.context as InvocationContext;
    const modelContext = model.context as InvocationContext;
    expect(mcpContext.authorityPrincipalKey).toBe(modelContext.authorityPrincipalKey);
    expect(mcpContext.requestBinding.requestHashSha256).not.toBe(modelContext.requestBinding.requestHashSha256);
    expect(JSON.stringify(mcpContext)).not.toContain(mcpToken);
    expect(modelContext.provenance).toEqual({
      kind: 'app_model',
      agentRunId: ids.agentRun,
      modelAttemptId: ids.modelAttempt,
      modelToolCallId: ids.modelToolCall
    });
  });

  test('open public policy is a distinct read-only authority lane', async () => {
    const openLane = lane('public_open');
    const builder = createReadInvocationContextBuilder({
      reference: definitionRef('context.public-read'),
      operation: { name: 'public.read', version: 1 },
      effect: 'read',
      lanes: [openLane],
      scopeResolver: { resolve: () => scope() },
      authorityResolver: {
        resolve(input) {
          return {
            kind: 'authorized',
            authority: {
              actor: { kind: 'public_request', publicPolicyRevisionId: ids.publicPolicy, authority: { kind: 'open_policy' } },
              principal: { kind: 'public_capability', publicPolicyRevisionId: ids.publicPolicy, authority: { kind: 'open_policy' } },
              lane: input.lane,
              scope: input.scope,
              grants: [{ kind: 'public_policy', key: 'test.public.read' }],
              evidenceIds: ['public-policy-current:v1'],
              authorityCitationIds: [],
              evaluatedAt: input.evaluatedAt
            }
          } as const;
        }
      },
      clock: { now: () => now },
      newInvocationId: () => ids.invocation,
      authorityPrincipalKeyProfile: profile,
      scopePartitionProfile: profile,
      requestCanonicalizationProfile: profile,
      deniedAuthorityOutcome: authorityOutcome
    });
    const built = await builder.build({
      operationName: 'public.read', operationVersion: 1, surface: 'public_http', correlationId,
      businessInput: { value: 'public' },
      verifiedEvidence: { kind: 'public_open', surface: 'public_http', client: { key: 'public.test' }, publicPolicyRevisionId: ids.publicPolicy }
    });
    expect(built.kind).toBe('ready');
    if (built.kind !== 'ready') throw new Error('expected public read context');
    expect((built.context as InvocationContext).provenance).toEqual({ kind: 'public_open', publicPolicyRevisionId: ids.publicPolicy });
  });

  test('public effect and app-model commit lanes remain unavailable', async () => {
    const base = {
      reference: definitionRef('context.closed-effect'),
      operation: { name: 'closed.commit', version: 1 },
      effect: 'commit' as const,
      scopeResolver: { resolve: () => scope() },
      authorityResolver: operatorAuthorityResolver('current'),
      clock: { now: () => now },
      newInvocationId: () => ids.invocation,
      authorityPrincipalKeyProfile: profile,
      scopePartitionProfile: profile,
      requestCanonicalizationProfile: profile,
      requestHashProfile: refs.requestHash,
      requestHashSealer: createHmacRequestHashSealer({
        profile: refs.requestHash,
        keyBytes: new Uint8Array(32).fill(0x34)
      }),
      idempotencyCredentialProfile: profile,
      deniedAuthorityOutcome: authorityOutcome,
      idempotencyCredentialSealer: { seal: async (raw: string) => ({ verifierProfile: profile, verifierSha256: await sha256(raw) }) }
    };
    const publicBuilder = createEffectInvocationContextBuilder({ ...base, lanes: [lane('public_ceremony')] });
    await expect(publicBuilder.build({
      operationName: 'closed.commit', operationVersion: 1, surface: 'public_http', correlationId,
      businessInput: { value: 'x' }, rawIdempotencyKey: 'key',
      verifiedEvidence: { kind: 'public_ceremony', surface: 'public_http', client: { key: 'public.test' }, ceremonyEvidenceId: ids.ceremony }
    })).rejects.toMatchObject({ code: 'public_mutation_disabled' });

    const openBuilder = createEffectInvocationContextBuilder({ ...base, lanes: [lane('public_open')] });
    await expect(openBuilder.build({
      operationName: 'closed.commit', operationVersion: 1, surface: 'public_http', correlationId,
      businessInput: { value: 'x' }, rawIdempotencyKey: 'key',
      verifiedEvidence: { kind: 'public_open', surface: 'public_http', client: { key: 'public.test' }, publicPolicyRevisionId: ids.publicPolicy }
    })).rejects.toMatchObject({ code: 'public_mutation_disabled' });

    const modelBuilder = createEffectInvocationContextBuilder({ ...base, lanes: [lane('app_model')] });
    await expect(modelBuilder.build({
      operationName: 'closed.commit', operationVersion: 1, surface: 'app_model', correlationId,
      businessInput: { value: 'x' }, rawIdempotencyKey: 'key',
      verifiedEvidence: { kind: 'app_model', surface: 'app_model', client: { key: 'model.test' }, agentRunId: ids.agentRun, modelAttemptId: ids.modelAttempt, modelToolCallId: ids.modelToolCall }
    })).rejects.toMatchObject({ code: 'app_model_commit_forbidden' });
  });
});
