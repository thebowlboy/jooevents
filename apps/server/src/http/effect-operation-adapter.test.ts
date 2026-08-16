import { describe, expect, test } from 'bun:test';
import {
  createEffectInvocationBuilder,
  createEffectInvocationContextBuilder,
  createEffectOperationExecutor,
  createHmacRequestHashSealer,
  createOperationAutonomyPolicy,
  createOperationRegistry,
  createSingleUnitOfWorkConformanceFixture,
  isSealedInvocationContext,
  recheckEffectInvocationCurrentAuthority,
  type EffectOperationIdentity,
  type EffectUnitOfWork,
  type EffectUnitOfWorkPort,
  type OperationRegistrySource,
  type RegisteredOperatorHttpEffectBinding,
  type ShortOperationAuditRecord,
  type TerminalEffectReceipt
} from '@jooevents/application';
import {
  createEffectfulOperationResultSchema,
  structuredOutcomeSchema,
  type SafeSchemaManifestRef,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import { parseOperationAccessLane } from '@jooevents/identity-access';
import {
  parseContractVersion,
  parseInstant,
  parseInvocationId,
  parseMembershipId,
  parseUserId,
  parseWorkspaceId
} from '@jooevents/kernel';
import { z } from 'zod';
import { createHttpApp } from './app';
import { createOperatorEffectHttpAdapter } from './effect-operation-adapter';

const requestedCorrelationId = '018f0f47-7a86-7d36-8a25-9f86589c7a4d';
const retryCorrelationId = '018f0f47-7a86-7d36-8a25-9f86589c7a4e';
const receiptId = '018f0f47-7a86-7d36-8a25-9f86589c7b40';
const routePath = '/api/test/effect-adapter-proof';
const digest = (seed: string) => seed.repeat(64);
const schemaRef = (key: string, seed: string): SafeSchemaManifestRef => ({
  key,
  version: 1,
  digestSha256: digest(seed)
});
const definitionRef = (key: string): VersionedDefinitionRef => ({ key, version: 1 });
const refs = {
  input: schemaRef('schema.effect-adapter-proof.input', '1'),
  contribution: schemaRef('schema.effect-adapter-proof.contribution', '2'),
  canonical: schemaRef('schema.effect-adapter-proof.canonical', '3'),
  projected: schemaRef('schema.effect-adapter-proof.operator-result', '4'),
  nullDetail: schemaRef('schema.effect-adapter-proof.null-detail', '5'),
  context: definitionRef('context.effect-adapter-proof'),
  autonomy: definitionRef('autonomy.effect-adapter-proof'),
  capability: definitionRef('capability.effect-adapter-proof-write'),
  handler: definitionRef('handler.effect-adapter-proof'),
  projection: definitionRef('projection.effect-adapter-proof-operator'),
  keySource: definitionRef('idempotency.operator-header'),
  requestHash: definitionRef('request-hash.canonical-input'),
  concurrency: definitionRef('concurrency.effect-adapter-proof'),
  audit: definitionRef('audit.effect-adapter-proof'),
  auditRecordProfile: definitionRef('audit-record.canonical-json')
} as const;

const authorityIds = {
  workspace: parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000'),
  user: parseUserId('01890f47-9abc-7def-8123-456789abc001'),
  membership: parseMembershipId('01890f47-9abc-7def-8123-456789abc002'),
  invocation: parseInvocationId('01890f47-9abc-7def-8123-456789abc003')
} as const;
const authorityInstant = parseInstant('2026-08-11T00:00:00.000Z');
const keyProfile = { key: 'server-effect-adapter-test', version: parseContractVersion(1) } as const;
const operatorLane = parseOperationAccessLane({
  kind: 'operator',
  surface: 'operator_http',
  policy: { key: 'authority.server-effect-adapter-test', version: 1 }
});

const inputSchema = z.strictObject({ value: z.string().min(1) });
const canonicalSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: z.strictObject({ value: z.string() }) }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);
const contributionSchema = z.strictObject({
  result: canonicalSchema,
  domain: z.strictObject({ value: z.string() }),
  effectContributions: z.array(z.strictObject({ kind: z.literal('domain_evidence'), value: z.string() }))
});
const projectedSchema = createEffectfulOperationResultSchema(z.strictObject({ value: z.string() }));

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digestBytes = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digestBytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

interface ProofTracker {
  verifierCalls: number;
  preflightLookups: number;
  unitOfWorkBegins: number;
  handlerCalls: number;
  domainWrites: number;
  commits: number;
  readonly bindings: RegisteredOperatorHttpEffectBinding[];
}

function provingSource(tracker: ProofTracker, invalidProjection = false): OperationRegistrySource {
  const contextBuilder = createEffectInvocationContextBuilder({
    reference: refs.context,
    operation: { name: 'adapter-proof.draft', version: 1 },
    effect: 'draft',
    lanes: [operatorLane],
    scopeResolver: {
      resolve: () => ({
        workspaceId: authorityIds.workspace,
        subjects: [{ kind: 'workspace', id: authorityIds.workspace }],
        resolutionEvidenceIds: ['workspace-target:v1']
      })
    },
    authorityResolver: {
      resolve: (input) => input.evidence.kind === 'operator' && input.evidence.sessionHandle !== 'denied'
        ? {
            kind: 'authorized',
            authority: {
              actor: { kind: 'workspace_user', userId: authorityIds.user },
              principal: {
                kind: 'workspace_user',
                userId: authorityIds.user,
                membershipId: authorityIds.membership
              },
              lane: input.lane,
              scope: input.scope,
              grants: [{ kind: 'permission', key: 'test.effect-adapter.write' }],
              evidenceIds: ['membership-current:v1'],
              authorityCitationIds: [],
              evaluatedAt: input.evaluatedAt
            }
          }
        : { kind: 'denied', reason: 'not_authorized' }
    },
    clock: { now: () => authorityInstant },
    newInvocationId: () => parseInvocationId(crypto.randomUUID()),
    authorityPrincipalKeyProfile: keyProfile,
    scopePartitionProfile: keyProfile,
    requestCanonicalizationProfile: keyProfile,
    requestHashProfile: refs.requestHash,
    requestHashSealer: createHmacRequestHashSealer({
      profile: refs.requestHash,
      keyBytes: new Uint8Array(32).fill(0x35)
    }),
    idempotencyCredentialProfile: keyProfile,
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
        return {
          verifierProfile: keyProfile,
          verifierSha256: await sha256(`key:v1:${rawIdempotencyKey}`)
        };
      }
    }
  });

  const autonomyPolicy = createOperationAutonomyPolicy({
      definition: refs.autonomy,
      operation: { name: 'adapter-proof.draft', version: 1 },
      riskFloor: 'normal',
      unattendedRiskCeiling: 'normal',
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
  const phaseControl = createSingleUnitOfWorkConformanceFixture({
    operation: { name: 'adapter-proof.draft', version: 1, effect: 'draft' },
    maximumRisk: 'normal',
    consequenceTags: [],
    autonomyPolicy,
    handler: refs.handler,
    handlerCapability: refs.capability,
    contributionSchema: refs.contribution,
    nullDetailSchema: refs.nullDetail
  });
  return {
    ...phaseControl.registrations,
    autonomyPolicies: [autonomyPolicy],
    schemas: [
      { reference: refs.input, schema: inputSchema },
      { reference: refs.contribution, schema: contributionSchema },
      { reference: refs.canonical, schema: canonicalSchema },
      { reference: refs.projected, schema: projectedSchema },
      { reference: refs.nullDetail, schema: z.null() }
    ],
    contextBuilders: [],
    readCapabilities: [],
    handlers: [],
    projections: [{
      reference: refs.projection,
      canonicalResultSchema: refs.canonical,
      projectedResultSchema: refs.projected,
      project: (candidate) => {
        const canonical = canonicalSchema.parse(candidate);
        return invalidProjection && canonical.kind === 'success'
          ? { kind: 'success', data: { secretUnexpectedField: canonical.data.value } }
          : canonical;
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
      effect: 'draft',
      handlerCapability: refs.capability,
      contributionSchema: refs.contribution,
      canonicalResultSchema: refs.canonical,
      handle: ({ businessInput, context }) => {
        tracker.handlerCalls += 1;
        expect(isSealedInvocationContext(context)).toBe(true);
        const request = inputSchema.parse(businessInput);
        return {
          result: { kind: 'success' as const, data: { value: request.value } },
          domain: { value: request.value },
          effectContributions: [{ kind: 'domain_evidence' as const, value: request.value }]
        };
      }
    }],
    effectOperations: [{
      name: 'adapter-proof.draft',
      version: 1,
      lifecycle: { status: 'active' },
      summary: 'Create an inert adapter proof draft.',
      effect: 'draft',
      maxRisk: 'normal',
      autonomyPolicy: refs.autonomy,
      consequenceTags: [],
      inputSchema: refs.input,
      contributionSchema: refs.contribution,
      canonicalResultSchema: refs.canonical,
      outcomes: [{
        class: 'idempotency_conflict',
        kind: 'operation.request_changed',
        retryable: false,
        detailSchema: refs.nullDetail
      }, {
        class: 'access_denied',
        kind: 'authority.denied',
        retryable: false,
        detailSchema: refs.nullDetail
      }, phaseControl.contentionOutcomeDeclaration, ...phaseControl.outcomeDeclarations],
      accessLanes: [operatorLane],
      contextBuilder: refs.context,
      handlerCapability: refs.capability,
      handler: refs.handler,
      audit: { mode: 'required', target: refs.audit },
      idempotency: {
        keySource: refs.keySource,
        credentialVerifierProfile: keyProfile,
        requestHashProfile: refs.requestHash
      },
      concurrency: refs.concurrency,
      execution: phaseControl.execution,
      bindings: [{
        surface: 'operator_http',
        method: 'POST',
        path: routePath,
        input: 'body',
        browserResumption: { kind: 'none' },
        projection: refs.projection
      }]
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

class MemoryEffectUnitOfWork implements EffectUnitOfWorkPort {
  private receipts = new Map<string, TerminalEffectReceipt>();
  private domain: unknown[] = [];
  readonly tracker: ProofTracker;

  constructor(tracker: ProofTracker) {
    this.tracker = tracker;
  }

  get receiptCount() { return this.receipts.size; }
  get domainCount() { return this.domain.length; }

  findTerminalReceipt(identity: EffectOperationIdentity): TerminalEffectReceipt | undefined {
    this.tracker.preflightLookups += 1;
    return this.receipts.get(identityKey(identity));
  }

  recordShortOperationAudit(_record: ShortOperationAuditRecord): void {}

  async runInUnitOfWork<Value>(work: (unitOfWork: EffectUnitOfWork) => Promise<Value>): Promise<Value> {
    this.tracker.unitOfWorkBegins += 1;
    const receipts = new Map(this.receipts);
    const domain = [...this.domain];
    const unitOfWork: EffectUnitOfWork = {
      recheckCurrentAuthority: (context) => recheckEffectInvocationCurrentAuthority(context),
      findTerminalReceipt(identity) {
        return receipts.get(identityKey(identity));
      },
      openHandlerSnapshot: () => ({ currentValue: null }),
      applyDomainContribution: (contribution) => {
        domain.push(structuredClone(contribution));
        this.tracker.domainWrites += 1;
      },
      insertOperationLog(record) {
        const key = identityKey(record.receipt.identity);
        if (receipts.has(key)) throw new Error('duplicate receipt');
        receipts.set(key, record.receipt);
      },
      applyEffectContribution(parentReceiptId) {
        if (![...receipts.values()].some((receipt) => receipt.ref.id === parentReceiptId)) {
          throw new Error('operation log missing');
        }
      }
    };
    try {
      const result = await work(unitOfWork);
      this.receipts = receipts;
      this.domain = domain;
      this.tracker.commits += 1;
      return result;
    } catch (error) {
      this.tracker.domainWrites = this.domain.length;
      throw error;
    }
  }
}

async function harness(options: {
  readonly invalidProjection?: boolean;
  readonly loseFirstCommittedResponse?: boolean;
} = {}) {
  const tracker: ProofTracker = {
    verifierCalls: 0,
    preflightLookups: 0,
    unitOfWorkBegins: 0,
    handlerCalls: 0,
    domainWrites: 0,
    commits: 0,
    bindings: []
  };
  const registry = await createOperationRegistry(provingSource(tracker, options.invalidProjection ?? false));
  const unitOfWork = new MemoryEffectUnitOfWork(tracker);
  const builder = createEffectInvocationBuilder(registry);
  const effectExecutor = createEffectOperationExecutor({ registry, unitOfWork, newOperationLogId: () => receiptId });
  let loseCommittedResponse = options.loseFirstCommittedResponse ?? false;
  const executor = {
    async execute(invocation: Parameters<typeof effectExecutor.execute>[0]) {
      const result = await effectExecutor.execute(invocation);
      if (loseCommittedResponse) {
        loseCommittedResponse = false;
        throw new Error('simulated response loss after committed effect');
      }
      return result;
    }
  };
  const app = createOperatorEffectHttpAdapter({
    registry,
    builder,
    executor,
    evidence: {
      verify: ({ request, binding }) => {
        tracker.verifierCalls += 1;
        tracker.bindings.push(binding);
        const session = request.headers.get('x-test-session');
        if (session === 'forbidden') return { kind: 'rejected', reason: 'forbidden' };
        if (session !== 'valid' && session !== 'denied') return { kind: 'rejected', reason: 'unauthenticated' };
        return {
          kind: 'verified',
          evidence: {
            kind: 'operator',
            surface: 'operator_http',
            client: { key: 'web.test' },
            sessionHandle: session
          }
        };
      }
    }
  });
  return { app, tracker, registry, unitOfWork };
}

function trustedHeaders(
  idempotency = 'adapter-proof-key',
  correlationId = requestedCorrelationId
): HeadersInit {
  return {
    'content-type': 'application/json; charset=utf-8',
    'idempotency-key': idempotency,
    'x-test-session': 'valid',
    'x-correlation-id': correlationId
  };
}

function post(app: Awaited<ReturnType<typeof harness>>['app'], value: unknown, headers: HeadersInit = trustedHeaders()) {
  return app.request(routePath, { method: 'POST', headers, body: JSON.stringify(value) });
}

describe('generic operator effect HTTP adapter', () => {
  test('derives the exact sealed-registry route and preserves the canonical response envelope', async () => {
    const proof = await harness();
    const response = await post(proof.app, { value: 'alpha' });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
    expect(response.headers.get('x-correlation-id')).toBe(requestedCorrelationId);
    expect(await response.json()).toEqual({
      kind: 'success',
      data: { value: 'alpha' },
      receipt: { id: receiptId, operationName: 'adapter-proof.draft', operationVersion: 1 },
      correlationId: requestedCorrelationId
    });
    expect(proof.tracker.bindings).toEqual([...proof.registry.operatorHttpEffectBindings]);
    expect((await proof.app.request('/api/test/unregistered-effect', {
      method: 'POST', headers: trustedHeaders(), body: JSON.stringify({ value: 'alpha' })
    })).status).toBe(404);
  });

  test('response loss replays once and a changed request hash is a detail-free conflict', async () => {
    const proof = await harness();
    const first = await post(proof.app, { value: 'alpha' });
    expect(first.status).toBe(200);
    const firstPayload = await first.json();

    const replay = await post(
      proof.app,
      { value: 'alpha' },
      trustedHeaders('adapter-proof-key', retryCorrelationId)
    );
    expect(replay.status).toBe(200);
    expect(replay.headers.get('x-correlation-id')).toBe(retryCorrelationId);
    expect(await replay.json()).toEqual(firstPayload);
    expect(firstPayload).toMatchObject({ correlationId: requestedCorrelationId });

    const changed = await post(proof.app, { value: 'changed' });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toEqual({
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
      correlationId: requestedCorrelationId
    });
    expect(proof.tracker.handlerCalls).toBe(1);
    expect(proof.tracker.domainWrites).toBe(1);
    expect(proof.tracker.commits).toBe(1);
    expect(proof.unitOfWork.receiptCount).toBe(1);
    expect(proof.unitOfWork.domainCount).toBe(1);
  });

  test('an exception after a committed effect never advertises blind retryability', async () => {
    const proof = await harness({ loseFirstCommittedResponse: true });
    const lost = await post(proof.app, { value: 'accepted-before-response-loss' });
    expect(lost.status).toBe(500);
    expect(await lost.json()).toEqual({
      kind: 'transport_error',
      code: 'internal_error',
      retryable: false,
      correlationId: requestedCorrelationId
    });
    expect(proof.unitOfWork.receiptCount).toBe(1);
    expect(proof.unitOfWork.domainCount).toBe(1);

    const replay = await post(proof.app, { value: 'accepted-before-response-loss' });
    expect(replay.status).toBe(200);
    expect(proof.tracker.handlerCalls).toBe(1);
    expect(proof.unitOfWork.receiptCount).toBe(1);
    expect(proof.unitOfWork.domainCount).toBe(1);
  });

  test('application authority denial happens before receipt lookup or a unit of work', async () => {
    const proof = await harness();
    const response = await post(proof.app, { value: 'alpha' }, {
      ...trustedHeaders(),
      'x-test-session': 'denied'
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      kind: 'outcome',
      outcome: { class: 'access_denied', kind: 'authority.denied', detail: null },
      terminal: false
    });
    expect(proof.tracker.preflightLookups).toBe(0);
    expect(proof.tracker.unitOfWorkBegins).toBe(0);
    expect(proof.tracker.handlerCalls).toBe(0);
  });

  test('caller authority, scope, and approval claims cannot enter the operation', async () => {
    for (const field of ['actor', 'scope', 'approval'] as const) {
      const proof = await harness();
      const response = await post(proof.app, { value: 'alpha', [field]: 'attacker-selected' });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        kind: 'transport_error', code: 'invalid_request', retryable: false, correlationId: requestedCorrelationId
      });
      expect(proof.tracker.preflightLookups).toBe(0);
      expect(proof.tracker.unitOfWorkBegins).toBe(0);
    }
  });

  test('rejects invalid media, JSON, and bounded single-value idempotency headers safely', async () => {
    const proof = await harness();
    const invalidMedia = await proof.app.request(routePath, {
      method: 'POST',
      headers: { ...trustedHeaders(), 'content-type': 'text/plain' },
      body: JSON.stringify({ value: 'alpha' })
    });
    expect(invalidMedia.status).toBe(400);
    expect(proof.tracker.verifierCalls).toBe(0);

    const invalidJson = await proof.app.request(routePath, {
      method: 'POST', headers: trustedHeaders(), body: '{not-json'
    });
    expect(invalidJson.status).toBe(400);
    expect(proof.tracker.verifierCalls).toBe(1);

    for (const invalidKey of ['', 'secret key', 'secret\tkey', 'first,second', 'x'.repeat(257)]) {
      const headers = new Headers(trustedHeaders());
      if (invalidKey) headers.set('idempotency-key', invalidKey);
      else headers.delete('idempotency-key');
      const response = await proof.app.request(routePath, {
        method: 'POST', headers, body: JSON.stringify({ value: 'alpha' })
      });
      expect(response.status).toBe(400);
      expect(JSON.stringify(await response.json())).not.toContain(invalidKey || 'adapter-proof-key');
    }

    const duplicated = new Headers(trustedHeaders('first-secret'));
    duplicated.append('idempotency-key', 'second-secret');
    const duplicateResponse = await proof.app.request(routePath, {
      method: 'POST', headers: duplicated, body: JSON.stringify({ value: 'alpha' })
    });
    expect(duplicateResponse.status).toBe(400);
    expect(JSON.stringify(await duplicateResponse.json())).not.toContain('first-secret');
    expect(proof.tracker.verifierCalls).toBe(1);
    expect(proof.tracker.preflightLookups).toBe(0);
    expect(proof.tracker.unitOfWorkBegins).toBe(0);
  });

  test('protocol rejection stays a safe transport error and never builds application authority', async () => {
    for (const [session, status, code] of [
      ['missing', 401, 'unauthenticated'],
      ['forbidden', 403, 'forbidden']
    ] as const) {
      const proof = await harness();
      const response = await post(proof.app, { value: 'alpha' }, {
        ...trustedHeaders(),
        'x-test-session': session
      });
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({
        kind: 'transport_error', code, retryable: false, correlationId: requestedCorrelationId
      });
      expect(proof.tracker.preflightLookups).toBe(0);
      expect(proof.tracker.unitOfWorkBegins).toBe(0);
    }
  });

  test('invalid projected lane output rolls back and returns only a safe internal error', async () => {
    const proof = await harness({ invalidProjection: true });
    const response = await post(proof.app, { value: 'private-value' });
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({
      kind: 'transport_error', code: 'internal_error', retryable: false, correlationId: requestedCorrelationId
    });
    expect(JSON.stringify(body)).not.toContain('private-value');
    expect(proof.unitOfWork.receiptCount).toBe(0);
    expect(proof.unitOfWork.domainCount).toBe(0);
    expect(proof.tracker.commits).toBe(0);
  });

  test('the production HTTP app does not activate the trial adapter route', async () => {
    const production = createHttpApp({
      auth: { handler: () => new Response(null, { status: 401 }), api: {} } as never,
      accessContext: { ensureAuthPrincipalProvisioned: () => { throw new Error('not reached'); } },
      workspaceId: 'workspace-test',
      baseUrl: 'http://localhost:5176'
    });
    const response = await production.request(routePath, {
      method: 'POST', headers: trustedHeaders(), body: JSON.stringify({ value: 'alpha' })
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'route_not_found', retryable: false });
  });
});
