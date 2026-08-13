import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  createEffectInvocationBuilder,
  createEffectInvocationContextBuilder,
  createEffectOperationExecutor,
  createHmacRequestHashSealer,
  createOperationAutonomyPolicy,
  createOperationRegistry,
  createSingleUnitOfWorkConformanceFixture,
  type EffectAuthorityRecheckSource,
  type EffectInvocationContext,
  type OperationRegistrySource,
  type RegisteredOperationSchema
} from '@jooevents/application';
import {
  effectfulOperationResultSchema,
  structuredOutcomeSchema,
  type SafeSchemaManifestRef,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import { parseOperationAccessLane } from '@jooevents/identity-access';
import {
  parseAggregateVersion,
  parseAuthorityCitationId,
  parseCapabilityRevisionId,
  parseConsumerAttemptId,
  parseConsumerDeliveryId,
  parseContractVersion,
  parseDomainFactId,
  parseEventId,
  parseInstant,
  parseInvocationId,
  parseWorkspaceId,
  type ConsumerAttemptId,
  type Instant
} from '@jooevents/kernel';
import {
  buildReliabilityRegistry,
  definitionRef,
  parseDefinitionKey,
  parseOpaqueSourceIdentity,
  parseOutboxPointerKey,
  schemaRef,
  sealReliabilityDefinition,
  type ConsumerDefinition,
  type DefinitionRef,
  type OutboxPointerRef,
  type ReliabilityRegistry,
  type SchemaRef
} from '@jooevents/reliability';
import {
  installFoundationTrialUnitOfWorkSchema,
  SQLiteTrialEffectUnitOfWorkPort,
  type SQLiteTrialEffectDomainAdapter
} from './foundation-trial-uow';
import {
  installSQLiteRegisteredConsumerOperationTrial,
  createSQLiteRegisteredConsumerOperationTrialRunner,
  RegisteredConsumerOperationTrialError,
  SQLiteRegisteredConsumerSourcePayloadTrial,
  type RegisteredConsumerAuthorityRegistration,
  type RegisteredConsumerInputProjectionRegistration,
  type RegisteredConsumerSourceSchemaRegistration
} from './registered-consumer-operation-trial';
import {
  installSQLiteReliabilityConsumerTrial,
  SQLiteReliabilityConsumerTrial
} from './reliability-consumer-trial';

const DIGEST_INPUT = '1'.repeat(64);
const DIGEST_RESULT = '2'.repeat(64);
const DIGEST_PAYLOAD = '3'.repeat(64);
const DIGEST_CONTRIBUTION = '4'.repeat(64);
const DIGEST_CANONICAL = '5'.repeat(64);
const DIGEST_DETAIL = '6'.repeat(64);

const ids = {
  workspace: parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000'),
  event: parseEventId('550e8400-e29b-41d4-a716-446655440001'),
  fact: parseDomainFactId('018f0f47-7a86-7d36-8a25-9f86589c0001'),
  delivery: parseConsumerDeliveryId('018f0f47-7a86-7d36-8a25-9f86589c0002'),
  attemptA: parseConsumerAttemptId('018f0f47-7a86-7d36-8a25-9f86589c0003'),
  attemptB: parseConsumerAttemptId('018f0f47-7a86-7d36-8a25-9f86589c0004'),
  capability: parseCapabilityRevisionId('018f0f47-7a86-7d36-8a25-9f86589c0005'),
  otherCapability: parseCapabilityRevisionId('018f0f47-7a86-7d36-8a25-9f86589c0006'),
  citation: parseAuthorityCitationId('018f0f47-7a86-7d36-8a25-9f86589c0007'),
  invocation: parseInvocationId('018f0f47-7a86-7d36-8a25-9f86589c0008'),
  pointer: parseOutboxPointerKey('ptr1_registered_consumer_trial'),
  sourceIdentity: parseOpaqueSourceIdentity('src1_registered_consumer_trial')
} as const;

const correlationId = '018f0f47-7a86-7d36-8a25-9f86589c0009';
const receiptIds = [
  '018f0f47-7a86-7d36-8a25-9f86589c0010',
  '018f0f47-7a86-7d36-8a25-9f86589c0011'
] as const;

const refs = {
  operation: definitionRef('operation', 'consumer.note.commit', 1),
  consumer: definitionRef('consumer', 'consumer.note.projection', 1),
  fact: definitionRef('domain_fact', 'note.created', 1),
  inputProjection: definitionRef('input_projection', 'consumer.note.input', 1),
  authorityCitation: definitionRef('authority_citation', 'consumer.note.authority', 1),
  backoff: definitionRef('backoff', 'bounded.exponential', 1),
  replay: definitionRef('replay', 'operation.receipt', 1),
  removal: definitionRef('removal', 'drain.then.remove', 1)
} as const;

const reliabilitySchemas = {
  input: schemaRef('schema.consumer.note.input', 1, DIGEST_INPUT),
  result: schemaRef('schema.consumer.note.result', 1, DIGEST_RESULT),
  payload: schemaRef('schema.note.created.payload', 1, DIGEST_PAYLOAD)
} as const;

type OperationSchema = RegisteredOperationSchema['schema'];

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parser(validate: (value: unknown) => unknown | undefined): OperationSchema {
  return {
    safeParse(value: unknown) {
      const data = validate(value);
      return data === undefined
        ? { success: false, error: {} }
        : { success: true, data };
    }
  } as unknown as OperationSchema;
}

function parse<Value>(schema: { safeParse(value: unknown): { success: boolean; data?: unknown } }, value: unknown): Value {
  const result = schema.safeParse(value);
  if (!result.success) throw new TypeError('test schema rejected value');
  return result.data as Value;
}

const inputSchema = parser((value) => {
  const candidate = record(value);
  return candidate
    && Object.keys(candidate).length === 1
    && typeof candidate.value === 'string'
    && candidate.value.length > 0
    ? { value: candidate.value }
    : undefined;
});
const sourcePayloadSchema = parser((value) => {
  const candidate = record(value);
  return candidate && typeof candidate.value === 'string' && candidate.value.length > 0
    ? structuredClone(candidate)
    : undefined;
});
const canonicalSchema = parser((value) => {
  const candidate = record(value);
  if (candidate?.kind === 'success') {
    const data = record(candidate.data);
    if (data && Object.keys(data).length === 1 && typeof data.value === 'string') {
      return { kind: 'success', data: { value: data.value } };
    }
  }
  if (candidate?.kind === 'outcome') {
    const outcome = structuredOutcomeSchema.safeParse(candidate.outcome);
    if (outcome.success) return { kind: 'outcome', outcome: outcome.data };
  }
  return undefined;
});
const contributionSchema = parser((value) => {
  const candidate = record(value);
  const result = canonicalSchema.safeParse(candidate?.result);
  const domain = record(candidate?.domain);
  if (
    !candidate
    || !result.success
    || !domain
    || Object.keys(domain).length !== 1
    || typeof domain.value !== 'string'
    || !Array.isArray(candidate.receiptChildren)
    || candidate.receiptChildren.length !== 0
  ) return undefined;
  return structuredClone(candidate);
});
const nullSchema = parser((value) => value === null ? null : undefined);
const projectedResultSchema = effectfulOperationResultSchema;

function appSchema(reference: SchemaRef): SafeSchemaManifestRef {
  return {
    key: reference.key,
    version: reference.version,
    digestSha256: reference.canonicalSchemaDigestSha256
  };
}

function appRef(key: string): VersionedDefinitionRef {
  return { key, version: 1 };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

class TrialClock {
  current: Instant = parseInstant('2026-08-11T00:00:00.000Z');
  now = () => this.current;
  advance(milliseconds: number) {
    this.current = parseInstant(new Date(Date.parse(this.current) + milliseconds).toISOString());
  }
}

interface HarnessState {
  authorized: boolean;
  failAfterCommit: boolean;
  handlerCalls: number;
  projectorCalls: number;
  projectorSawFrozen: boolean;
  readonly rawIdempotencyKeys: string[];
  readonly contexts: EffectInvocationContext[];
}

function createConsumerAuthorityResolver(input: {
  readonly reliability: SQLiteReliabilityConsumerTrial;
  readonly consumer: ConsumerDefinition;
  readonly state: HarnessState;
}): EffectAuthorityRecheckSource['resolveAuthority'] {
  return (resolution) => {
    if (resolution.evidence.kind !== 'registered_consumer') {
      return { kind: 'denied', reason: 'lane_mismatch' };
    }
    const evidence = resolution.evidence;
    const delivery = input.reliability.readDelivery(evidence.consumerDeliveryId);
    const attempt = delivery?.attempts.find(
      (candidate) => candidate.id === evidence.consumerAttemptId
    );
    if (!input.state.authorized) {
      return { kind: 'denied', reason: 'not_authorized' };
    }
    if (
      !delivery
      || !attempt
      || delivery.consumer.key !== input.consumer.key
      || delivery.consumer.version !== input.consumer.version
      || delivery.capabilityRevisionId !== input.consumer.capabilityRevisionId
      || delivery.authorityCitation.key !== input.consumer.authorityCitation.key
      || delivery.authorityCitation.version !== input.consumer.authorityCitation.version
      || (attempt.state !== 'running' && attempt.state !== 'succeeded')
    ) {
      return { kind: 'denied', reason: 'stale' };
    }
    return {
      kind: 'authorized',
      authority: {
        actor: {
          kind: 'system_consumer_delivery',
          consumerDeliveryId: delivery.id,
          consumerAttemptId: attempt.id,
          consumerKey: delivery.consumer.key,
          consumerVersion: delivery.consumer.version
        },
        principal: {
          kind: 'registered_consumer_delivery',
          consumerDeliveryId: delivery.id,
          consumerAttemptId: attempt.id,
          consumerKey: delivery.consumer.key,
          consumerVersion: delivery.consumer.version,
          capabilityRevisionId: delivery.capabilityRevisionId,
          authorityCitationId: ids.citation
        },
        lane: resolution.lane,
        scope: resolution.scope,
        grants: [{ kind: 'registered_capability', key: delivery.capabilityRevisionId }],
        evidenceIds: [`consumer-attempt:${attempt.id}`],
        authorityCitationIds: [ids.citation],
        evaluatedAt: resolution.evaluatedAt
      }
    };
  };
}

async function definitions(maximumAttempts = 3): Promise<{
  readonly consumer: ConsumerDefinition;
  readonly registry: ReliabilityRegistry;
}> {
  const fact = await sealReliabilityDefinition({
    kind: 'domain_fact',
    key: parseDefinitionKey(refs.fact.key),
    version: parseContractVersion(refs.fact.version),
    metadataSchema: reliabilitySchemas.payload,
    producers: [{ kind: 'operation', operation: refs.operation }],
    aggregateKind: parseDefinitionKey('note'),
    subjectIdentity: definitionRef('subject_identity', 'note.subject', 1),
    scope: definitionRef('scope', 'event.scope', 1),
    causalParent: definitionRef('causal_parent', 'operation.receipt', 1),
    consumerCompatibility: definitionRef('consumer_compatibility', 'exact.source', 1),
    classifiedPayloadPaths: [],
    redaction: definitionRef('redaction', 'note.fact', 1)
  });
  const consumer = await sealReliabilityDefinition({
    kind: 'consumer',
    key: parseDefinitionKey(refs.consumer.key),
    version: parseContractVersion(refs.consumer.version),
    acceptedSources: [refs.fact],
    inputSchema: reliabilitySchemas.input,
    resultSchema: reliabilitySchemas.result,
    inputProjection: refs.inputProjection,
    targetOperation: refs.operation,
    capabilityRevisionId: ids.capability,
    authorityCitation: refs.authorityCitation,
    maximumAttempts,
    leaseDurationMs: 30_000,
    backoff: refs.backoff,
    outputKind: 'application_operation',
    replay: refs.replay,
    removal: refs.removal
  });
  return { consumer, registry: await buildReliabilityRegistry([fact, consumer]) };
}

function operationSource(input: {
  readonly reliability: SQLiteReliabilityConsumerTrial;
  readonly consumer: ConsumerDefinition;
  readonly clock: TrialClock;
  readonly state: HarnessState;
  readonly resolveAuthority: EffectAuthorityRecheckSource['resolveAuthority'];
}): OperationRegistrySource {
  const lane = parseOperationAccessLane({
    kind: 'registered_consumer',
    surface: 'application_job',
    policy: { key: 'authority.consumer-note-trial', version: 1 }
  });
  const operationName = refs.operation.key;
  const autonomy = createOperationAutonomyPolicy({
    definition: appRef('autonomy.consumer-note-trial'),
    operation: { name: operationName, version: refs.operation.version },
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
  const profile = { key: 'registered-consumer-trial', version: parseContractVersion(1) };
  const requestHashProfile = appRef('request-hash.canonical-input');
  const contextBuilder = createEffectInvocationContextBuilder({
    reference: appRef('context.consumer-note-trial'),
    operation: { name: operationName, version: refs.operation.version },
    effect: 'commit',
    lanes: [lane],
    scopeResolver: {
      resolve: ({ evidence }) => {
        if (evidence.kind !== 'registered_consumer') throw new TypeError('consumer evidence required');
        return {
          workspaceId: ids.workspace,
          eventId: ids.event,
          subjects: [
            { kind: 'workspace', id: ids.workspace },
            { kind: 'event', id: ids.event }
          ],
          resolutionEvidenceIds: [`consumer-delivery:${evidence.consumerDeliveryId}`]
        };
      }
    },
    authorityResolver: {
      resolve: input.resolveAuthority
    },
    clock: input.clock,
    newInvocationId: () => parseInvocationId(crypto.randomUUID()),
    authorityPrincipalKeyProfile: profile,
    scopePartitionProfile: profile,
    requestCanonicalizationProfile: profile,
    requestHashProfile,
    requestHashSealer: createHmacRequestHashSealer({ profile: requestHashProfile, keyBytes: new Uint8Array(32).fill(0x3b) }),
    idempotencyCredentialProfile: profile,
    idempotencyCredentialSealer: {
      async seal(rawIdempotencyKey) {
        input.state.rawIdempotencyKeys.push(rawIdempotencyKey);
        return {
          verifierProfile: profile,
          verifierSha256: await sha256(`consumer-key:v1:${rawIdempotencyKey}`)
        };
      }
    },
    deniedAuthorityOutcome: () => ({
      class: 'access_denied',
      kind: 'authority.denied',
      retryable: false,
      subjects: [],
      detail: null,
      detailSchemaVersion: 1
    })
  });

  const canonicalRef: SafeSchemaManifestRef = {
    key: 'schema.consumer.note.canonical', version: 1, digestSha256: DIGEST_CANONICAL
  };
  const contributionRef: SafeSchemaManifestRef = {
    key: 'schema.consumer.note.contribution', version: 1, digestSha256: DIGEST_CONTRIBUTION
  };
  const detailRef: SafeSchemaManifestRef = {
    key: 'schema.operation.request-changed-detail', version: 1, digestSha256: DIGEST_DETAIL
  };
  const projectionRef = appRef('projection.consumer-note-result');
  const handlerRef = appRef('handler.consumer-note-commit');
  const handlerCapability = appRef('capability.consumer-note-write');
  const auditTarget = appRef('audit.consumer-note-commit');
  const auditRecordProfile = appRef('audit-record.canonical-json');
  const phaseControl = createSingleUnitOfWorkConformanceFixture({
    operation: { name: operationName, version: refs.operation.version, effect: 'commit' },
    maximumRisk: 'normal',
    consequenceTags: [],
    autonomyPolicy: autonomy,
    handler: handlerRef,
    handlerCapability,
    contributionSchema: contributionRef,
    nullDetailSchema: detailRef
  });
  return {
    ...phaseControl.registrations,
    autonomyPolicies: [autonomy],
    schemas: [
      { reference: appSchema(reliabilitySchemas.input), schema: inputSchema },
      { reference: appSchema(reliabilitySchemas.result), schema: projectedResultSchema },
      { reference: canonicalRef, schema: canonicalSchema },
      { reference: contributionRef, schema: contributionSchema },
      { reference: detailRef, schema: nullSchema }
    ],
    contextBuilders: [],
    readCapabilities: [],
    handlers: [],
    projections: [{
      reference: projectionRef,
      canonicalResultSchema: canonicalRef,
      projectedResultSchema: appSchema(reliabilitySchemas.result),
      project: (candidate) => parse(canonicalSchema, candidate)
    }],
    operations: [],
    effectContextBuilders: [contextBuilder],
    operationAuditTargets: [{
      reference: auditTarget,
      kind: 'operation_audit_record',
      recordProfile: auditRecordProfile
    }],
    operationAuditRecordProfiles: [{
      reference: auditRecordProfile,
      kind: 'canonical_json',
      maximumBytes: 65_536
    }],
    effectHandlers: [{
      reference: handlerRef,
      effect: 'commit',
      handlerCapability,
      contributionSchema: contributionRef,
      canonicalResultSchema: canonicalRef,
      handle: ({ businessInput, context }) => {
        input.state.handlerCalls += 1;
        input.state.contexts.push(context);
        const request = parse<{ readonly value: string }>(inputSchema, businessInput);
        return {
          result: { kind: 'success' as const, data: { value: request.value } },
          domain: { value: request.value },
          receiptChildren: []
        };
      }
    }],
    effectOperations: [{
      name: operationName,
      version: refs.operation.version,
      lifecycle: { status: 'active' },
      summary: 'Commit one registered consumer projection.',
      effect: 'commit',
      maxRisk: 'normal',
      autonomyPolicy: autonomy.definition,
      consequenceTags: [],
      inputSchema: appSchema(reliabilitySchemas.input),
      contributionSchema: contributionRef,
      canonicalResultSchema: canonicalRef,
      outcomes: [{
        class: 'idempotency_conflict',
        kind: 'operation.request_changed',
        retryable: false,
        detailSchema: detailRef
      }, {
        class: 'access_denied',
        kind: 'authority.denied',
        retryable: false,
        detailSchema: detailRef
      }, phaseControl.contentionOutcomeDeclaration, ...phaseControl.outcomeDeclarations],
      accessLanes: [lane],
      contextBuilder: contextBuilder.reference,
      handlerCapability,
      handler: handlerRef,
      audit: { mode: 'required', target: auditTarget },
      idempotency: {
        keySource: appRef('idempotency.consumer-delivery-attempt'),
        credentialVerifierProfile: profile,
        requestHashProfile
      },
      concurrency: appRef('concurrency.consumer-note'),
      execution: phaseControl.execution,
      bindings: [],
      registeredConsumerBindings: [{
        surface: 'application_job',
        lane: 'registered_consumer',
        consumer: { key: input.consumer.key, version: input.consumer.version },
        projection: projectionRef
      }]
    }]
  };
}

async function harness(options: {
  readonly maximumAttempts?: number;
  readonly attemptIds?: readonly ConsumerAttemptId[];
} = {}) {
  const sqlite = new Database(':memory:');
  installSQLiteReliabilityConsumerTrial(sqlite);
  installSQLiteRegisteredConsumerOperationTrial(sqlite);
  installFoundationTrialUnitOfWorkSchema(sqlite);
  sqlite.exec(`
    CREATE TABLE registered_consumer_domain_results_trial (
      id INTEGER PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
  `);
  const clock = new TrialClock();
  const reliability = new SQLiteReliabilityConsumerTrial(sqlite, clock);
  const sealed = await definitions(options.maximumAttempts);
  const state: HarnessState = {
    authorized: true,
    failAfterCommit: false,
    handlerCalls: 0,
    projectorCalls: 0,
    projectorSawFrozen: false,
    rawIdempotencyKeys: [],
    contexts: []
  };
  const resolveAuthority = createConsumerAuthorityResolver({
    reliability,
    consumer: sealed.consumer,
    state
  });
  const transactionAuthority = {
    resolveAuthority,
    now: clock.now
  } satisfies EffectAuthorityRecheckSource;
  const operationRegistry = await createOperationRegistry(operationSource({
    reliability,
    consumer: sealed.consumer,
    clock,
    state,
    resolveAuthority
  }));
  const sourceSchemas: readonly RegisteredConsumerSourceSchemaRegistration[] = [{
    source: refs.fact,
    payloadSchema: reliabilitySchemas.payload,
    schema: sourcePayloadSchema
  }];
  const projectors: readonly RegisteredConsumerInputProjectionRegistration[] = [{
    reference: refs.inputProjection,
    acceptedSources: [refs.fact],
    sourcePayloadSchema: reliabilitySchemas.payload,
    projectedInputSchema: reliabilitySchemas.input,
    project: ({ pointer, payload }) => {
      state.projectorCalls += 1;
      state.projectorSawFrozen = Object.isFrozen(pointer)
        && Object.isFrozen(pointer.source)
        && Object.isFrozen(payload);
      try {
        (payload as { value: string }).value = 'mutated';
      } catch {
        // The projector receives immutable evidence.
      }
      return {
        value: parse<{ readonly value: string }>(sourcePayloadSchema, payload).value
      };
    }
  }];
  const authority: readonly RegisteredConsumerAuthorityRegistration[] = [{
    consumer: refs.consumer,
    capabilityRevisionId: ids.capability,
    authorityCitation: refs.authorityCitation
  }];
  const sources = new SQLiteRegisteredConsumerSourcePayloadTrial(sqlite, sourceSchemas);
  const domain: SQLiteTrialEffectDomainAdapter = {
    openHandlerSnapshot: () => ({}),
    applyDomainContribution: (candidate) => {
      const contribution = record(candidate);
      if (!contribution || typeof contribution.value !== 'string') {
        throw new TypeError('invalid domain contribution');
      }
      sqlite.query('INSERT INTO registered_consumer_domain_results_trial (value) VALUES (?)')
        .run(contribution.value);
    },
    afterUnitOfWorkCommitted: () => {
      if (state.failAfterCommit) {
        state.failAfterCommit = false;
        throw new Error('simulated_response_loss');
      }
    }
  };
  let receiptIndex = 0;
  let attemptIndex = 0;
  const runnerInput = {
    sqlite,
    operationRegistry,
    reliabilityRegistry: sealed.registry,
    reliability,
    sources,
    sourceSchemas,
    inputProjectors: projectors,
    authority,
    domain,
    transactionAuthority,
    workerKey: 'worker.registered-consumer-a',
    newAttemptId: () => options.attemptIds?.[attemptIndex++] ?? ids.attemptA,
    newCorrelationId: () => correlationId,
    newReceiptId: () => receiptIds[receiptIndex++] ?? crypto.randomUUID()
  } as const;
  const runner = createSQLiteRegisteredConsumerOperationTrialRunner(runnerInput);

  const pointer = reliability.appendFactBackedPointer({
    factId: ids.fact,
    sourceIdentity: ids.sourceIdentity,
    pointerKey: ids.pointer,
    fact: refs.fact,
    aggregateVersion: parseAggregateVersion(1),
    scope: { kind: 'event', workspaceId: ids.workspace, eventId: ids.event },
    occurredAt: clock.now(),
    availableAt: clock.now()
  });
  reliability.fanout({
    pointerKey: pointer.key,
    consumers: [sealed.consumer],
    deliveryIdFor: () => ids.delivery
  });
  sources.append({
    pointer,
    payload: {
      value: 'foundation',
      operationName: 'payload.selected.operation',
      projection: 'payload.selected.projection',
      scope: { workspaceId: 'payload-selected' },
      actor: { kind: 'payload-selected' },
      approval: { id: 'payload-selected' },
      capabilityRevisionId: ids.otherCapability,
      authorityCitation: 'payload-selected',
      idempotencyKey: 'payload-selected'
    }
  });

  const run = (overrides: Partial<{
    faults: { afterClaimed?: () => void; afterAtomicDeliveryCompletion?: () => void };
  }> = {}) => runner.run({
    deliveryId: ids.delivery,
    ...(overrides.faults ? { faults: overrides.faults } : {})
  });

  return {
    sqlite,
    reliability,
    reliabilityRegistry: sealed.registry,
    consumer: sealed.consumer,
    operationRegistry,
    sourceSchemas,
    projectors,
    authority,
    sources,
    domain,
    transactionAuthority,
    clock,
    state,
    runnerInput,
    runner,
    run,
    pointer
  };
}

function count(sqlite: Database, table: string): number {
  const allowed = new Set([
    'registered_consumer_domain_results_trial',
    'foundation_trial_operation_receipts',
    'foundation_trial_operation_audits',
    'foundation_trial_operation_receipt_children',
    'reliability_consumer_attempt_completions_trial'
  ]);
  if (!allowed.has(table)) throw new TypeError('unknown trial table');
  return Number(sqlite.query<{ readonly total: number }, []>(
    `SELECT count(*) AS total FROM ${table}`
  ).get()?.total ?? 0);
}

describe('registered consumer operation SQLite trial', () => {
  test('dispatches one exact hidden operation with immutable projection and trusted authority', async () => {
    const trial = await harness();
    const result = await trial.run();
    expect(result.kind).toBe('terminal');
    expect(result.kind === 'terminal' && result.replay).toBe(false);
    expect(result.result).toMatchObject({
      kind: 'success',
      data: { value: 'foundation' },
      receipt: { operationName: refs.operation.key, operationVersion: 1 }
    });
    expect(result.delivery.state).toBe('succeeded');
    expect(trial.state.handlerCalls).toBe(1);
    expect(trial.state.projectorCalls).toBe(1);
    expect(trial.state.projectorSawFrozen).toBe(true);
    expect(trial.state.rawIdempotencyKeys).toEqual([
      `consumer-delivery:${ids.delivery}:attempt:${ids.attemptA}`
    ]);
    expect(count(trial.sqlite, 'registered_consumer_domain_results_trial')).toBe(1);
    expect(count(trial.sqlite, 'foundation_trial_operation_receipts')).toBe(1);
    expect(count(trial.sqlite, 'foundation_trial_operation_receipt_children')).toBe(0);
    expect(trial.sqlite.query<{ readonly disposition: string; readonly receipt_id: string | null }, []>(`
      SELECT disposition, receipt_id FROM foundation_trial_operation_audits
    `).get()).toMatchObject({ disposition: 'terminal_new', receipt_id: result.result.kind === 'success' ? result.result.receipt.id : null });
    expect(count(trial.sqlite, 'reliability_consumer_attempt_completions_trial')).toBe(1);
    const context = trial.state.contexts[0];
    expect(context?.surface).toBe('application_job');
    expect(context?.provenance).toEqual({
      kind: 'registered_consumer',
      consumerDeliveryId: ids.delivery,
      consumerAttemptId: ids.attemptA
    });
    expect(context?.actor).toMatchObject({
      kind: 'system_consumer_delivery',
      consumerKey: refs.consumer.key,
      consumerVersion: 1
    });
    expect(context?.scope).toMatchObject({ workspaceId: ids.workspace, eventId: ids.event });
    expect(JSON.stringify(trial.operationRegistry.safeManifest)).not.toContain(refs.consumer.key);
    expect(trial.operationRegistry.safeManifest.operations).toEqual([]);
    expect(trial.operationRegistry.operatorHttpEffectBindings).toEqual([]);
    expect(() => trial.sqlite.query(`
      UPDATE registered_consumer_source_payloads_trial
         SET payload_json = '{"value":"changed"}'
       WHERE pointer_key = ?
    `).run(ids.pointer)).toThrow('registered_consumer_source_payload_immutable');
  });

  test('rolls back receipt, domain, and delivery completion together, then resumes the same attempt', async () => {
    const trial = await harness();
    await expect(trial.run({
      faults: { afterAtomicDeliveryCompletion: () => { throw new Error('crash_before_commit'); } }
    })).rejects.toThrow();
    expect(trial.reliability.readDelivery(ids.delivery)?.state).toBe('leased');
    expect(count(trial.sqlite, 'registered_consumer_domain_results_trial')).toBe(0);
    expect(count(trial.sqlite, 'foundation_trial_operation_receipts')).toBe(0);
    expect(count(trial.sqlite, 'reliability_consumer_attempt_completions_trial')).toBe(0);

    const recovered = await trial.run();
    expect(recovered.kind).toBe('terminal');
    expect(trial.reliability.listAttemptEvidence(ids.delivery)).toHaveLength(1);
    expect(count(trial.sqlite, 'registered_consumer_domain_results_trial')).toBe(1);
    expect(count(trial.sqlite, 'foundation_trial_operation_receipts')).toBe(1);
    expect(count(trial.sqlite, 'foundation_trial_operation_audits')).toBe(1);
  });

  test('response loss restarts into terminal replay without another contribution', async () => {
    const trial = await harness();
    trial.state.failAfterCommit = true;
    await expect(trial.run()).rejects.toMatchObject({ phase: 'unit_of_work' });
    expect(trial.reliability.readDelivery(ids.delivery)?.state).toBe('succeeded');
    expect(count(trial.sqlite, 'registered_consumer_domain_results_trial')).toBe(1);
    expect(count(trial.sqlite, 'foundation_trial_operation_receipts')).toBe(1);
    const replay = await trial.run();
    expect(replay.kind).toBe('terminal');
    expect(replay.kind === 'terminal' && replay.replay).toBe(true);
    expect(trial.state.handlerCalls).toBe(1);
    expect(count(trial.sqlite, 'registered_consumer_domain_results_trial')).toBe(1);
    expect(count(trial.sqlite, 'foundation_trial_operation_receipts')).toBe(1);
    expect(trial.sqlite.query<{ readonly disposition: string }, []>(`
      SELECT disposition FROM foundation_trial_operation_audits ORDER BY rowid
    `).all().map((row) => row.disposition)).toEqual(['terminal_new', 'terminal_replay']);
  });

  test('an already-durable receipt completes separately only for the same current delivery attempt', async () => {
    const trial = await harness();
    trial.reliability.claim({
      deliveryId: ids.delivery,
      attemptId: ids.attemptA,
      ownerKey: 'worker.registered-consumer-a'
    });
    const invocation = await createEffectInvocationBuilder(trial.operationRegistry)
      .buildRegisteredConsumer({
        consumer: { key: refs.consumer.key, version: refs.consumer.version },
        correlationId,
        businessInput: { value: 'foundation' },
        verifiedEvidence: {
          kind: 'registered_consumer',
          surface: 'application_job',
          client: { key: 'worker.registered-consumer' },
          consumerDeliveryId: ids.delivery,
          consumerAttemptId: ids.attemptA
        },
        rawIdempotencyKey: `consumer-delivery:${ids.delivery}:attempt:${ids.attemptA}`
      });
    await createEffectOperationExecutor({
      registry: trial.operationRegistry,
      unitOfWork: new SQLiteTrialEffectUnitOfWorkPort(
        trial.sqlite,
        trial.domain,
        trial.transactionAuthority
      ),
      newReceiptId: () => receiptIds[0]
    }).execute(invocation);
    expect(trial.reliability.readDelivery(ids.delivery)?.state).toBe('leased');
    expect(count(trial.sqlite, 'foundation_trial_operation_receipts')).toBe(1);

    const replay = await trial.run();
    expect(replay.kind).toBe('terminal');
    expect(replay.kind === 'terminal' && replay.replay).toBe(true);
    expect(replay.delivery.state).toBe('succeeded');
    expect(trial.state.handlerCalls).toBe(1);
    expect(count(trial.sqlite, 'registered_consumer_domain_results_trial')).toBe(1);
  });

  test('lost-fence takeover prevents the stale runner from building or executing', async () => {
    const trial = await harness();
    await expect(trial.run({
      faults: {
        afterClaimed: () => {
          trial.clock.advance(31_000);
          trial.reliability.claim({
            deliveryId: ids.delivery,
            attemptId: ids.attemptB,
            ownerKey: 'worker.registered-consumer-b'
          });
        }
      }
    })).rejects.toMatchObject({ code: 'lost_fence' });
    const attempts = trial.reliability.listAttemptEvidence(ids.delivery);
    expect(attempts.map((attempt) => attempt.completion?.state ?? 'running')).toEqual([
      'lost_fence', 'running'
    ]);
    expect(trial.state.projectorCalls).toBe(0);
    expect(trial.state.handlerCalls).toBe(0);
    expect(count(trial.sqlite, 'foundation_trial_operation_receipts')).toBe(0);
    expect(count(trial.sqlite, 'registered_consumer_domain_results_trial')).toBe(0);
  });

  test('recovers a crashed maximumAttempts=1 consumer with a new winner and rejects the stale fence', async () => {
    const trial = await harness({
      maximumAttempts: 1,
      attemptIds: [ids.attemptA, ids.attemptB]
    });
    await expect(trial.run({
      faults: {
        afterClaimed: () => {
          throw new Error('simulated_worker_crash');
        }
      }
    })).rejects.toThrow('simulated_worker_crash');
    const crashed = trial.reliability.readDelivery(ids.delivery)!;
    const staleFence = crashed.currentFence!;
    expect(crashed.maximumAttempts).toBe(1);
    expect(crashed.attempts.map((attempt) => attempt.state)).toEqual(['running']);

    trial.clock.advance(31_000);
    const recovered = await trial.run({
      faults: {
        afterClaimed: () => {
          expect(() => trial.reliability.completeOperation({
            deliveryId: ids.delivery,
            fence: staleFence
          })).toThrow(/lost its lease fence/);
        }
      }
    });

    expect(recovered.kind).toBe('terminal');
    expect(recovered.delivery.state).toBe('succeeded');
    expect(trial.reliability.listAttemptEvidence(ids.delivery).map((attempt) => ({
      number: Number(attempt.number),
      fence: Number(attempt.fence),
      state: attempt.completion?.state ?? 'running'
    }))).toEqual([
      { number: 1, fence: 1, state: 'lost_fence' },
      { number: 2, fence: 2, state: 'succeeded' }
    ]);
    expect(trial.state.handlerCalls).toBe(1);
    expect(count(trial.sqlite, 'foundation_trial_operation_receipts')).toBe(1);
    expect(count(trial.sqlite, 'registered_consumer_domain_results_trial')).toBe(1);
  });

  test('current-authority denial stays nonterminal and precedes receipt/domain work', async () => {
    const trial = await harness();
    trial.state.authorized = false;
    const denied = await trial.run();
    expect(denied.kind).toBe('nonterminal');
    expect(denied.result).toMatchObject({
      kind: 'outcome',
      terminal: false,
      outcome: { class: 'access_denied', kind: 'authority.denied' }
    });
    expect(trial.reliability.readDelivery(ids.delivery)?.state).toBe('leased');
    expect(trial.state.handlerCalls).toBe(0);
    expect(count(trial.sqlite, 'foundation_trial_operation_receipts')).toBe(0);
    expect(trial.sqlite.query<{ readonly disposition: string; readonly receipt_id: string | null; readonly related_receipt_id: string | null }, []>(`
      SELECT disposition, receipt_id, related_receipt_id FROM foundation_trial_operation_audits
    `).get()).toEqual({ disposition: 'context_denied', receipt_id: null, related_receipt_id: null });
    expect(count(trial.sqlite, 'registered_consumer_domain_results_trial')).toBe(0);

    trial.state.authorized = true;
    const recovered = await trial.run();
    expect(recovered.kind).toBe('terminal');
  });

  test('definition snapshots and startup joins fail closed without selector leakage', async () => {
    const trial = await harness();
    trial.sqlite.query(`
      UPDATE reliability_consumer_deliveries_trial
         SET target_operation_key = 'payload.selected.operation'
       WHERE delivery_id = ?
    `).run(ids.delivery);
    await expect(trial.run()).rejects.toMatchObject({ code: 'delivery_mismatch' });
    expect(trial.state.projectorCalls).toBe(0);
    expect(trial.state.handlerCalls).toBe(0);

    expect(() => createSQLiteRegisteredConsumerOperationTrialRunner({
      ...trial.runnerInput,
      authority: [{
        consumer: refs.consumer,
        capabilityRevisionId: ids.otherCapability,
        authorityCitation: refs.authorityCitation
      }]
    })).toThrow(RegisteredConsumerOperationTrialError);
    expect(() => createSQLiteRegisteredConsumerOperationTrialRunner({
      ...trial.runnerInput,
      inputProjectors: trial.projectors.map((projector) => ({
        ...projector,
        projectedInputSchema: schemaRef(
          projector.projectedInputSchema.key,
          projector.projectedInputSchema.version,
          'f'.repeat(64)
        )
      }))
    })).toThrow(RegisteredConsumerOperationTrialError);
  });

  test('async or schema-substituted input projectors cannot reach authority or the handler', async () => {
    const trial = await harness();
    const asyncRunner = createSQLiteRegisteredConsumerOperationTrialRunner({
      ...trial.runnerInput,
      inputProjectors: trial.projectors.map((projector) => ({
        ...projector,
        project: () => Promise.resolve({ value: 'not-allowed' })
      }))
    });
    await expect(asyncRunner.run({ deliveryId: ids.delivery })).rejects.toMatchObject({
      code: 'projection_failed'
    });
    expect(trial.state.handlerCalls).toBe(0);
    expect(count(trial.sqlite, 'foundation_trial_operation_receipts')).toBe(0);

    const another = await harness();
    const wrongShapeRunner = createSQLiteRegisteredConsumerOperationTrialRunner({
      ...another.runnerInput,
      inputProjectors: another.projectors.map((projector) => ({
        ...projector,
        project: () => ({ actor: { kind: 'payload-selected' } })
      }))
    });
    await expect(wrongShapeRunner.run({ deliveryId: ids.delivery })).rejects.toMatchObject({
      code: 'projection_failed'
    });
    expect(another.state.handlerCalls).toBe(0);
    expect(count(another.sqlite, 'foundation_trial_operation_receipts')).toBe(0);
  });
});
