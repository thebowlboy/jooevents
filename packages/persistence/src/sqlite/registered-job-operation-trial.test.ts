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
  type OperationRegistry,
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
  createPayloadRef,
  parseAggregateVersion,
  parseAuthorityCitationId,
  parseCapabilityRevisionId,
  parseContractVersion,
  parseEventId,
  parseInstant,
  parseInvocationId,
  parseJobId,
  parsePayloadRefId,
  parseWorkspaceId,
  type Clock,
  type Instant,
  type InvocationId,
  type JobId
} from '@jooevents/kernel';
import {
  buildReliabilityRegistry,
  definitionRef,
  parseDefinitionKey,
  parseOpaqueSourceIdentity,
  schemaRef,
  sealReliabilityDefinition,
  type ExternalRetryPolicy,
  type JobDefinition,
  type ReliabilityRegistry,
  type SchemaRef
} from '@jooevents/reliability';
import {
  installFoundationTrialUnitOfWorkSchema,
  SQLiteTrialEffectUnitOfWorkPort,
  type SQLiteTrialEffectDomainAdapter
} from './foundation-trial-uow';
import {
  createSQLiteRegisteredJobOperationTrialRunner,
  installSQLiteRegisteredJobOperationTrial,
  RegisteredJobOperationTrialError,
  sealRegisteredJobOperationTrialDispositionPolicy,
  SQLiteRegisteredJobInputTrial,
  type RegisteredJobInputProjectionRegistration,
  type RegisteredJobInputSchemaRegistration,
  type RegisteredJobOperationTrialDispositionPolicy
} from './registered-job-operation-trial';
import {
  installSQLiteReliabilityJobTrial,
  SQLiteReliabilityJobTrial
} from './reliability-job-trial';

const DIGEST_JOB_INPUT = '1'.repeat(64);
const DIGEST_OPERATION_INPUT = '2'.repeat(64);
const DIGEST_RESULT = '3'.repeat(64);
const DIGEST_ERROR = '4'.repeat(64);
const DIGEST_CANONICAL = '5'.repeat(64);
const DIGEST_CONTRIBUTION = '6'.repeat(64);
const DIGEST_DETAIL = '7'.repeat(64);

const ids = {
  workspace: parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000'),
  event: parseEventId('550e8400-e29b-41d4-a716-446655440001'),
  capability: parseCapabilityRevisionId('018f0f47-7a86-7d36-8a25-9f86589c0001'),
  citation: parseAuthorityCitationId('018f0f47-7a86-7d36-8a25-9f86589c0002')
} as const;

const refs = {
  job: definitionRef('job', 'note.dispatch', 1),
  source: definitionRef('source', 'note.dispatch-source', 1),
  sourceFact: definitionRef('domain_fact', 'note.requested', 1),
  scopeCausation: definitionRef('scope_causation', 'event.from-note-request', 1),
  inputProjection: definitionRef('input_projection', 'note.job-to-operation', 1),
  operation: definitionRef('operation', 'note.commit-from-job', 1),
  authorityCitation: definitionRef('authority_citation', 'note.job-authority', 1),
  backoff: definitionRef('backoff', 'note.job-backoff', 1),
  cancellation: definitionRef('cancellation', 'note.job-cancellation', 1),
  disposition: definitionRef('job_disposition', 'note.job-disposition-trial', 1)
} as const;

const reliabilitySchemas = {
  input: schemaRef('schema.note.job-input', 1, DIGEST_JOB_INPUT),
  result: schemaRef('schema.note.job-result', 1, DIGEST_RESULT),
  error: schemaRef('schema.note.job-error', 1, DIGEST_ERROR)
} as const;

const appRefs = {
  input: {
    key: 'schema.note.operation-input', version: 1, digestSha256: DIGEST_OPERATION_INPUT
  } satisfies SafeSchemaManifestRef,
  result: {
    key: reliabilitySchemas.result.key,
    version: reliabilitySchemas.result.version,
    digestSha256: reliabilitySchemas.result.canonicalSchemaDigestSha256
  } satisfies SafeSchemaManifestRef,
  canonical: {
    key: 'schema.note.job-canonical', version: 1, digestSha256: DIGEST_CANONICAL
  } satisfies SafeSchemaManifestRef,
  contribution: {
    key: 'schema.note.job-contribution', version: 1, digestSha256: DIGEST_CONTRIBUTION
  } satisfies SafeSchemaManifestRef,
  detail: {
    key: 'schema.note.job-detail', version: 1, digestSha256: DIGEST_DETAIL
  } satisfies SafeSchemaManifestRef,
  autonomy: { key: 'autonomy.note-job-trial', version: 1 },
  context: { key: 'context.note-job-trial', version: 1 },
  handler: { key: 'handler.note-job-trial', version: 1 },
  handlerCapability: { key: 'capability.note-job-write', version: 1 },
  resultProjection: { key: 'projection.note-job-result', version: 1 },
  keySource: { key: 'idempotency.registered-job', version: 1 },
  requestHash: { key: 'request-hash.note-job', version: 1 },
  concurrency: { key: 'concurrency.note-job', version: 1 },
  audit: { key: 'audit.note-job', version: 1 },
  auditRecordProfile: { key: 'audit-record.canonical-json', version: 1 }
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

const jobInputSchema = parser((value) => {
  const candidate = record(value);
  return candidate
    && Object.keys(candidate).length === 1
    && typeof candidate.message === 'string'
    && candidate.message.length > 0
    ? { message: candidate.message }
    : undefined;
});
const operationInputSchema = parser((value) => {
  const candidate = record(value);
  return candidate
    && Object.keys(candidate).length === 1
    && typeof candidate.value === 'string'
    && candidate.value.length > 0
    ? { value: candidate.value }
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
const resultSchema = effectfulOperationResultSchema;
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
    || !Array.isArray(candidate.effectContributions)
    || candidate.effectContributions.length !== 0
  ) return undefined;
  return structuredClone(candidate);
});
const nullSchema = parser((value) => value === null ? null : undefined);

function appRef(key: string): VersionedDefinitionRef {
  return { key, version: 1 };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

class TrialClock implements Clock {
  constructor(private milliseconds = Date.parse('2026-08-11T00:00:00.000Z')) {}
  now(): Instant { return parseInstant(new Date(this.milliseconds).toISOString()); }
  advance(durationMs: number): void { this.milliseconds += durationMs; }
}

interface HarnessState {
  authorized: boolean;
  projector: 'normal' | 'throw' | 'nondeterministic';
  handler: 'normal' | 'throw' | 'timeout';
  handlerCalls: number;
  projectorCalls: number;
  readonly rawKeys: string[];
  readonly trace: string[];
}

function createJobAuthorityResolver(input: {
  readonly jobs: SQLiteReliabilityJobTrial;
  readonly definition: JobDefinition;
  readonly state: HarnessState;
}): EffectAuthorityRecheckSource['resolveAuthority'] {
  return (resolution) => {
    if (resolution.evidence.kind !== 'registered_job') {
      return { kind: 'denied' as const, reason: 'lane_mismatch' as const };
    }
    const record = input.jobs.read(resolution.evidence.jobId);
    const lease = record?.job.lease;
    if (!input.state.authorized) {
      return { kind: 'denied' as const, reason: 'revoked' as const };
    }
    if (
      !record
      || record.job.state !== 'leased'
      || !lease
      || record.job.capabilityRevisionId !== input.definition.capabilityRevisionId
      || !sameRef(record.job.authorityCitation, input.definition.authorityCitation)
      || record.authorityCitationId !== ids.citation
    ) return { kind: 'denied' as const, reason: 'stale' as const };
    return {
      kind: 'authorized' as const,
      authority: {
        actor: {
          kind: 'system_job' as const,
          jobId: record.job.id,
          registeredCapabilityRevisionId: record.job.capabilityRevisionId
        },
        principal: {
          kind: 'registered_job' as const,
          jobId: record.job.id,
          capabilityRevisionId: record.job.capabilityRevisionId,
          authorityCitationId: record.authorityCitationId
        },
        lane: resolution.lane,
        scope: resolution.scope,
        grants: [{ kind: 'registered_capability' as const, key: record.job.capabilityRevisionId }],
        evidenceIds: [`job-current:${record.job.id}:${lease.attemptId}`],
        authorityCitationIds: [record.authorityCitationId],
        evaluatedAt: resolution.evaluatedAt
      }
    };
  };
}

interface Harness {
  readonly sqlite: Database;
  readonly clock: TrialClock;
  readonly state: HarnessState;
  readonly definition: JobDefinition;
  readonly reliabilityRegistry: ReliabilityRegistry;
  readonly operationRegistry: OperationRegistry;
  readonly jobs: SQLiteReliabilityJobTrial;
  readonly inputs: SQLiteRegisteredJobInputTrial;
  readonly inputSchemas: readonly RegisteredJobInputSchemaRegistration[];
  readonly projectors: readonly RegisteredJobInputProjectionRegistration[];
  readonly policy: RegisteredJobOperationTrialDispositionPolicy;
  readonly domain: SQLiteTrialEffectDomainAdapter;
  readonly transactionAuthority: EffectAuthorityRecheckSource;
  readonly nextAttemptId: (jobId: JobId) => InvocationId;
  readonly nextCorrelationId: (jobId: JobId, attemptId: InvocationId) => string;
  readonly nextReceiptId: () => string;
  createJob(input?: {
    readonly id?: JobId;
    readonly inputMessage?: string;
    readonly registeredIdentity?: string;
  }): JobId;
  runner(input?: { readonly workerKey?: string }): Promise<Awaited<ReturnType<typeof createSQLiteRegisteredJobOperationTrialRunner>>>;
}

let idCounter = 100;
function nextUuid(): string {
  const suffix = String(idCounter++).padStart(12, '0');
  return `018f0f47-7a86-7d36-8a25-${suffix}`;
}

async function jobDefinition(input: {
  readonly externalRetryPolicy?: ExternalRetryPolicy;
  readonly maximumAttempts?: number;
  readonly timeoutMs?: number;
} = {}): Promise<JobDefinition> {
  return sealReliabilityDefinition({
    kind: 'job',
    key: parseDefinitionKey(refs.job.key),
    version: parseContractVersion(refs.job.version),
    inputSchema: reliabilitySchemas.input,
    resultSchema: reliabilitySchemas.result,
    errorDetailSchema: reliabilitySchemas.error,
    source: refs.source,
    scopeCausation: refs.scopeCausation,
    inputProjection: refs.inputProjection,
    targetOperation: refs.operation,
    capabilityRevisionId: ids.capability,
    authorityCitation: refs.authorityCitation,
    leaseDurationMs: 30_000,
    maximumAttempts: input.maximumAttempts ?? 3,
    backoff: refs.backoff,
    timeoutMs: input.timeoutMs ?? 5_000,
    cancellation: refs.cancellation,
    externalRetryPolicy: input.externalRetryPolicy ?? 'anchor_inspection_only'
  });
}

async function defaultPolicy(input: {
  readonly operationNonterminal?: 'block' | 'safe_retry';
} = {}): Promise<RegisteredJobOperationTrialDispositionPolicy> {
  return sealRegisteredJobOperationTrialDispositionPolicy({
    reference: refs.disposition,
    operationNonterminal: input.operationNonterminal === 'safe_retry'
      ? { disposition: 'safe_retry', reasonCode: 'job.nonterminal_retry', retryDelayMs: 1_000 }
      : { disposition: 'block', reasonCode: 'job.nonterminal_blocked' },
    knownPreSubmissionFailure: {
      disposition: 'safe_retry', reasonCode: 'job.pre_submission_retry', retryDelayMs: 1_000
    },
    retryExhausted: { disposition: 'attention', reasonCode: 'job.retry_exhausted' },
    ambiguous: {
      anchorInspectionOnly: {
        disposition: 'reconcile', reasonCode: 'job.anchor_inspection_required'
      },
      forbidden: { disposition: 'block', reasonCode: 'job.retry_forbidden' }
    }
  });
}

async function harness(options: {
  readonly externalRetryPolicy?: ExternalRetryPolicy;
  readonly maximumAttempts?: number;
  readonly timeoutMs?: number;
  readonly operationNonterminal?: 'block' | 'safe_retry';
} = {}): Promise<Harness> {
  const sqlite = new Database(':memory:');
  installFoundationTrialUnitOfWorkSchema(sqlite);
  installSQLiteReliabilityJobTrial(sqlite);
  installSQLiteRegisteredJobOperationTrial(sqlite);
  sqlite.exec(`
    CREATE TABLE note_job_domain_trial (
      value TEXT PRIMARY KEY
    ) STRICT;
  `);
  const clock = new TrialClock();
  const jobs = new SQLiteReliabilityJobTrial(sqlite, clock);
  const definition = await jobDefinition(options);
  const reliabilityRegistry = await buildReliabilityRegistry([definition]);
  const state: HarnessState = {
    authorized: true,
    projector: 'normal',
    handler: 'normal',
    handlerCalls: 0,
    projectorCalls: 0,
    rawKeys: [],
    trace: []
  };
  const resolveAuthority = createJobAuthorityResolver({ jobs, definition, state });
  const transactionAuthority = {
    resolveAuthority,
    now: () => clock.now()
  } satisfies EffectAuthorityRecheckSource;
  const lane = parseOperationAccessLane({
    kind: 'registered_job',
    surface: 'application_job',
    policy: { key: 'authority.note-job-trial', version: 1 }
  });
  const profile = { key: 'registered-job-trial', version: parseContractVersion(1) };
  const contextBuilder = createEffectInvocationContextBuilder({
    reference: appRefs.context,
    operation: { name: refs.operation.key, version: refs.operation.version },
    effect: 'commit',
    lanes: [lane],
    scopeResolver: {
      resolve: ({ evidence }) => {
        if (evidence.kind !== 'registered_job') throw new TypeError('registered job evidence required');
        return {
          workspaceId: ids.workspace,
          eventId: ids.event,
          subjects: [
            { kind: 'workspace' as const, id: ids.workspace },
            { kind: 'event' as const, id: ids.event }
          ],
          resolutionEvidenceIds: [`job-scope:${evidence.jobId}`]
        };
      }
    },
    authorityResolver: {
      resolve: resolveAuthority
    },
    clock,
    newInvocationId: () => parseInvocationId(nextUuid()),
    authorityPrincipalKeyProfile: profile,
    scopePartitionProfile: profile,
    requestCanonicalizationProfile: profile,
    requestHashProfile: appRefs.requestHash,
    requestHashSealer: createHmacRequestHashSealer({ profile: appRefs.requestHash, keyBytes: new Uint8Array(32).fill(0x39) }),
    idempotencyCredentialProfile: profile,
    idempotencyCredentialSealer: {
      async seal(rawIdempotencyKey) {
        state.rawKeys.push(rawIdempotencyKey);
        return {
          verifierProfile: profile,
          verifierSha256: await sha256(`registered-job:v1:${rawIdempotencyKey}`)
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
  const autonomy = createOperationAutonomyPolicy({
    definition: appRefs.autonomy,
    operation: { name: refs.operation.key, version: refs.operation.version },
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
    operation: { name: refs.operation.key, version: refs.operation.version, effect: 'commit' },
    maximumRisk: 'normal',
    consequenceTags: [],
    autonomyPolicy: autonomy,
    handler: appRefs.handler,
    handlerCapability: appRefs.handlerCapability,
    contributionSchema: appRefs.contribution,
    nullDetailSchema: appRefs.detail
  });
  const operationSource: OperationRegistrySource = {
    ...phaseControl.registrations,
    autonomyPolicies: [autonomy],
    schemas: [
      { reference: appRefs.input, schema: operationInputSchema },
      { reference: appRefs.result, schema: resultSchema },
      { reference: appRefs.canonical, schema: canonicalSchema },
      { reference: appRefs.contribution, schema: contributionSchema },
      { reference: appRefs.detail, schema: nullSchema }
    ],
    contextBuilders: [],
    readCapabilities: [],
    handlers: [],
    projections: [{
      reference: appRefs.resultProjection,
      canonicalResultSchema: appRefs.canonical,
      projectedResultSchema: appRefs.result,
      project: (candidate) => parse(canonicalSchema, candidate)
    }],
    operations: [],
    effectContextBuilders: [contextBuilder],
    operationAuditTargets: [{
      reference: appRefs.audit,
      kind: 'operation_audit_record',
      recordProfile: appRefs.auditRecordProfile
    }],
    operationAuditRecordProfiles: [{
      reference: appRefs.auditRecordProfile,
      kind: 'canonical_json',
      maximumBytes: 65_536
    }],
    effectHandlers: [{
      reference: appRefs.handler,
      effect: 'commit',
      handlerCapability: appRefs.handlerCapability,
      contributionSchema: appRefs.contribution,
      canonicalResultSchema: appRefs.canonical,
      handle: ({ businessInput, context }) => {
        state.handlerCalls += 1;
        const request = parse<{ readonly value: string }>(operationInputSchema, businessInput);
        expect((context as EffectInvocationContext).authority.principal.kind).toBe('registered_job');
        if (state.handler === 'timeout') {
          clock.advance((options.timeoutMs ?? 5_000) + 1);
          throw new Error('provider acceptance unknown after timeout');
        }
        if (state.handler === 'throw') throw new Error('provider acceptance unknown');
        return {
          result: { kind: 'success' as const, data: { value: request.value } },
          domain: { value: request.value },
          effectContributions: []
        };
      }
    }],
    effectOperations: [{
      name: refs.operation.key,
      version: refs.operation.version,
      lifecycle: { status: 'active' },
      summary: 'Commit one registered job result.',
      effect: 'commit',
      maxRisk: 'normal',
      autonomyPolicy: appRefs.autonomy,
      consequenceTags: [],
      inputSchema: appRefs.input,
      contributionSchema: appRefs.contribution,
      canonicalResultSchema: appRefs.canonical,
      outcomes: [{
        class: 'idempotency_conflict',
        kind: 'operation.request_changed',
        retryable: false,
        detailSchema: appRefs.detail
      }, {
        class: 'access_denied',
        kind: 'authority.denied',
        retryable: false,
        detailSchema: appRefs.detail
      }, phaseControl.contentionOutcomeDeclaration, ...phaseControl.outcomeDeclarations],
      accessLanes: [lane],
      contextBuilder: appRefs.context,
      handlerCapability: appRefs.handlerCapability,
      handler: appRefs.handler,
      audit: { mode: 'required', target: appRefs.audit },
      idempotency: {
        keySource: appRefs.keySource,
        credentialVerifierProfile: profile,
        requestHashProfile: appRefs.requestHash
      },
      concurrency: appRefs.concurrency,
      execution: phaseControl.execution,
      bindings: [],
      registeredJobBindings: [{
        surface: 'application_job',
        lane: 'registered_job',
        job: { key: refs.job.key, version: refs.job.version },
        inputProjection: { key: refs.inputProjection.key, version: refs.inputProjection.version },
        capabilityRevisionId: ids.capability,
        authorityCitation: {
          key: refs.authorityCitation.key,
          version: refs.authorityCitation.version
        },
        projection: appRefs.resultProjection
      }]
    }]
  };
  const operationRegistry = await createOperationRegistry(operationSource);
  const inputSchemas: readonly RegisteredJobInputSchemaRegistration[] = [{
    job: refs.job,
    inputSchema: reliabilitySchemas.input,
    schema: jobInputSchema
  }];
  const inputs = new SQLiteRegisteredJobInputTrial(sqlite, inputSchemas);
  const projectors: readonly RegisteredJobInputProjectionRegistration[] = [{
    reference: refs.inputProjection,
    jobInputSchema: reliabilitySchemas.input,
    operationInputSchema: appRefs.input,
    project: (candidate) => {
      state.projectorCalls += 1;
      if (state.projector === 'throw') throw new Error('projection failed');
      const parsed = parse<{ readonly message: string }>(jobInputSchema, candidate);
      return {
        value: state.projector === 'nondeterministic'
          ? `${parsed.message}:${state.projectorCalls}`
          : parsed.message
      };
    }
  }];
  const policy = await defaultPolicy({
    ...(options.operationNonterminal
      ? { operationNonterminal: options.operationNonterminal }
      : {})
  });
  const domain: SQLiteTrialEffectDomainAdapter = {
    openHandlerSnapshot: (capability) => {
      expect(capability).toEqual(appRefs.handlerCapability);
      return {};
    },
    applyDomainContribution: (contribution) => {
      const parsed = parse<{ readonly value: string }>(operationInputSchema, contribution);
      sqlite.query('INSERT INTO note_job_domain_trial (value) VALUES (?)').run(parsed.value);
      state.trace.push('domain');
    },
    afterOperationLogInserted: () => {
      const job = jobs.read(activeJobId as JobId);
      const logs = sqlite.query<{ readonly count: number }, []>(
        'SELECT count(*) AS count FROM operation_log'
      ).get()?.count;
      state.trace.push(`parent_hook:job=${job?.job.state}:logs=${logs}`);
    }
  };
  let activeJobId: JobId | undefined;
  const nextAttemptId = () => parseInvocationId(nextUuid());
  const nextCorrelationId = () => nextUuid();
  const nextReceiptId = () => nextUuid();
  const createJob = (createInput: {
    readonly id?: JobId;
    readonly inputMessage?: string;
    readonly registeredIdentity?: string;
  } = {}): JobId => {
    const id = createInput.id ?? parseJobId(nextUuid());
    const inputRef = createPayloadRef(parsePayloadRefId(nextUuid()));
    inputs.append({
      job: refs.job,
      inputRef,
      value: { message: createInput.inputMessage ?? `message:${id}` }
    });
    jobs.create({
      id,
      definition,
      registeredIdempotencyIdentity: createInput.registeredIdentity ?? `semantic:${id}`,
      source: {
        definition: refs.sourceFact,
        identity: parseOpaqueSourceIdentity(`src1_job_${id.replaceAll('-', '_')}`),
        version: parseAggregateVersion(1)
      },
      inputRef,
      scope: { kind: 'event', workspaceId: ids.workspace, eventId: ids.event },
      authorityCitationId: ids.citation,
      dispositionPolicy: {
        reference: policy.reference,
        canonicalDigestSha256: policy.canonicalDigestSha256
      },
      availableAt: clock.now()
    });
    activeJobId = id;
    return id;
  };
  const runner = (runnerInput: { readonly workerKey?: string } = {}) =>
    createSQLiteRegisteredJobOperationTrialRunner({
      sqlite,
      operationRegistry,
      reliabilityRegistry,
      reliability: jobs,
      inputs,
      inputSchemas,
      inputProjectors: projectors,
      dispositionPolicies: [policy],
      domain,
      transactionAuthority,
      workerKey: runnerInput.workerKey ?? 'worker.registered-job-a',
      newAttemptId: nextAttemptId,
      newCorrelationId: nextCorrelationId,
      newOperationLogId: nextReceiptId
    });
  return {
    sqlite,
    clock,
    state,
    definition,
    reliabilityRegistry,
    operationRegistry,
    jobs,
    inputs,
    inputSchemas,
    projectors,
    policy,
    domain,
    transactionAuthority,
    nextAttemptId,
    nextCorrelationId,
    nextReceiptId,
    createJob,
    runner
  };
}

function sameRef(
  left: { readonly key: string; readonly version: number },
  right: { readonly key: string; readonly version: number }
): boolean {
  return left.key === right.key && left.version === right.version;
}

function count(sqlite: Database, table: string): number {
  return sqlite.query<{ readonly count: number }, []>(`SELECT count(*) AS count FROM ${table}`)
    .get()?.count ?? -1;
}

describe('disposable registered-job operation join', () => {
  test('fresh execution binds the exact job and atomically completes with its operation log', async () => {
    const test = await harness();
    const jobId = test.createJob({ inputMessage: 'alpha', registeredIdentity: 'semantic-alpha' });
    const runner = await test.runner();
    const result = await runner.run({ jobId });
    expect(result.kind).toBe('terminal');
    expect(result.kind === 'terminal' && result.replay).toBe(false);
    expect(result.job.job.state).toBe('succeeded');
    expect(result.job.job.lease).toBeNull();
    expect(test.state.handlerCalls).toBe(1);
    expect(test.state.projectorCalls).toBe(2);
    expect(test.state.trace).toEqual([
      'domain',
      'parent_hook:job=succeeded:logs=1'
    ]);
    expect(count(test.sqlite, 'operation_log')).toBe(1);
    expect(count(test.sqlite, 'note_job_domain_trial')).toBe(1);
    const attempt = test.jobs.listAttemptEvidence(jobId)[0];
    expect(attempt).toMatchObject({
      targetOperation: refs.operation,
      inputProjection: refs.inputProjection,
      capabilityRevisionId: ids.capability,
      authorityCitation: refs.authorityCitation,
      completion: { state: 'succeeded' }
    });
    expect(attempt?.completion?.receiptId).toBe(
      result.kind === 'terminal' && result.result.kind === 'success'
        ? result.result.receipt.id
        : undefined
    );
    expect(test.state.rawKeys).toEqual([
      `registered-job:${refs.job.key}@${refs.job.version}:${jobId}:semantic-alpha`
    ]);
    expect(JSON.stringify(result.kind === 'terminal' ? result.result : null))
      .not.toContain('semantic-alpha');
    expect(test.sqlite.query<{ readonly result_json: string }, []>(
      'SELECT result_json FROM operation_log'
    ).get()?.result_json).not.toContain('semantic-alpha');
  });

  test('claim loss and an in-transaction completion crash restart the same durable attempt', async () => {
    const claimed = await harness();
    const claimedJobId = claimed.createJob({ inputMessage: 'claimed' });
    const claimedRunner = await claimed.runner();
    await expect(claimedRunner.run({
      jobId: claimedJobId,
      faults: { afterClaimed: () => { throw new Error('process-lost-after-claim'); } }
    })).rejects.toThrow('process-lost-after-claim');
    expect(claimed.jobs.require(claimedJobId).job.state).toBe('leased');
    expect(claimed.jobs.listAttemptEvidence(claimedJobId)).toHaveLength(1);
    const resumed = await claimedRunner.run({ jobId: claimedJobId });
    expect(resumed.kind).toBe('terminal');
    expect(claimed.jobs.listAttemptEvidence(claimedJobId)).toHaveLength(1);

    const atomic = await harness();
    const atomicJobId = atomic.createJob({ inputMessage: 'atomic' });
    const atomicRunner = await atomic.runner();
    await expect(atomicRunner.run({
      jobId: atomicJobId,
      faults: { afterAtomicJobCompletion: () => { throw new Error('process-lost-in-parent-hook'); } }
    })).rejects.toThrow('process-lost-in-parent-hook');
    expect(atomic.jobs.require(atomicJobId).job.state).toBe('leased');
    expect(count(atomic.sqlite, 'operation_log')).toBe(0);
    expect(count(atomic.sqlite, 'note_job_domain_trial')).toBe(0);
    expect(atomic.jobs.listAttemptEvidence(atomicJobId)[0]?.completion).toBeNull();
    const retried = await atomicRunner.run({ jobId: atomicJobId });
    expect(retried.kind).toBe('terminal');
    expect(atomic.jobs.listAttemptEvidence(atomicJobId)).toHaveLength(1);
  });

  test('an authentic pre-existing receipt terminal-replays and then completes the job', async () => {
    const test = await harness();
    const jobId = test.createJob({ inputMessage: 'replay', registeredIdentity: 'semantic-replay' });
    const claimed = test.jobs.claim({
      jobId,
      invocationId: test.nextAttemptId(jobId),
      ownerKey: 'worker.registered-job-a'
    });
    const builder = createEffectInvocationBuilder(test.operationRegistry, {
      registeredJobAnchorResolver: {
        resolve: () => ({ registeredIdempotencyIdentity: claimed.job.registeredIdempotencyIdentity })
      }
    });
    const invocation = await builder.buildRegisteredJob({
      job: { key: refs.job.key, version: refs.job.version },
      jobId,
      correlationId: nextUuid(),
      businessInput: { value: 'replay' }
    });
    const executor = createEffectOperationExecutor({
      registry: test.operationRegistry,
      unitOfWork: new SQLiteTrialEffectUnitOfWorkPort(
        test.sqlite,
        test.domain,
        test.transactionAuthority
      ),
      newOperationLogId: test.nextReceiptId
    });
    const first = await executor.execute(invocation);
    expect(first.kind).toBe('success');
    expect(test.jobs.require(jobId).job.state).toBe('leased');
    expect(count(test.sqlite, 'operation_log')).toBe(1);

    const runner = await test.runner();
    await expect(runner.run({
      jobId,
      faults: { afterReplayReceiptResolved: () => { throw new Error('replay-response-loss'); } }
    })).rejects.toThrow('replay-response-loss');
    expect(test.jobs.require(jobId).job.state).toBe('leased');
    const replay = await runner.run({ jobId });
    expect(replay.kind).toBe('terminal');
    expect(replay.kind === 'terminal' && replay.replay).toBe(true);
    expect(test.state.handlerCalls).toBe(1);
    expect(test.jobs.require(jobId).job.state).toBe('succeeded');
    expect(test.state.rawKeys).toEqual([
      `registered-job:${refs.job.key}@${refs.job.version}:${jobId}:semantic-replay`,
      `registered-job:${refs.job.key}@${refs.job.version}:${jobId}:semantic-replay`,
      `registered-job:${refs.job.key}@${refs.job.version}:${jobId}:semantic-replay`
    ]);
  });

  test('current-authority denial becomes a durable nonterminal disposition and releases the lease', async () => {
    const test = await harness();
    const jobId = test.createJob({ inputMessage: 'denied' });
    test.state.authorized = false;
    const result = await (await test.runner()).run({ jobId });
    expect(result.kind).toBe('nonterminal');
    expect(result.kind === 'nonterminal' && result.result).toMatchObject({
      kind: 'outcome',
      outcome: { class: 'access_denied', kind: 'authority.denied' },
      terminal: false
    });
    expect(result.job.job.state).toBe('dead_lettered');
    expect(result.job.job.lease).toBeNull();
    expect(test.jobs.readLatestDisposition(jobId)).toMatchObject({
      cause: 'operation_nonterminal',
      disposition: 'block',
      reasonCode: 'job.nonterminal_blocked'
    });
    expect(test.state.handlerCalls).toBe(0);
    expect(count(test.sqlite, 'operation_log')).toBe(0);
  });

  test('a known pre-submission projection failure retries only by its registered gate', async () => {
    const test = await harness();
    const jobId = test.createJob({ inputMessage: 'project' });
    test.state.projector = 'nondeterministic';
    const first = await (await test.runner()).run({ jobId });
    expect(first.kind).toBe('settled');
    expect(first.kind === 'settled' && first.cause).toBe('known_pre_submission_failure');
    expect(first.job.job.state).toBe('retry_wait');
    expect(first.job.job.lease).toBeNull();
    expect(test.jobs.readLatestDisposition(jobId)).toMatchObject({
      disposition: 'safe_retry',
      reasonCode: 'job.pre_submission_retry'
    });
    expect(test.state.handlerCalls).toBe(0);
    test.clock.advance(1_001);
    test.state.projector = 'normal';
    const second = await (await test.runner()).run({ jobId });
    expect(second.kind).toBe('terminal');
    expect(test.jobs.listAttemptEvidence(jobId)).toHaveLength(2);
    expect(test.jobs.require(jobId).job.registeredIdempotencyIdentity).toBe(`semantic:${jobId}`);
  });

  test('a registered physical retry retains one semantic anchor across attempt identities', async () => {
    const test = await harness({ operationNonterminal: 'safe_retry' });
    const jobId = test.createJob({
      inputMessage: 'stable-retry',
      registeredIdentity: 'semantic-stable-retry'
    });
    test.state.authorized = false;
    const first = await (await test.runner()).run({ jobId });
    expect(first.kind).toBe('nonterminal');
    expect(first.job.job.state).toBe('retry_wait');
    test.clock.advance(1_001);
    test.state.authorized = true;
    const second = await (await test.runner()).run({ jobId });
    expect(second.kind).toBe('terminal');
    const attempts = test.jobs.listAttemptEvidence(jobId);
    expect(attempts).toHaveLength(2);
    expect(attempts.map((attempt) => attempt.targetOperation)).toEqual([
      refs.operation,
      refs.operation
    ]);
    expect(test.jobs.require(jobId).job.registeredIdempotencyIdentity)
      .toBe('semantic-stable-retry');
    expect(test.state.rawKeys).toEqual([
      `registered-job:${refs.job.key}@${refs.job.version}:${jobId}:semantic-stable-retry`
    ]);
  });

  test('ambiguous failure, timeout, and expired takeover never become blind retries', async () => {
    for (const retryPolicy of ['anchor_inspection_only', 'forbidden'] as const) {
      const ambiguous = await harness({ externalRetryPolicy: retryPolicy });
      const ambiguousJobId = ambiguous.createJob({ inputMessage: 'ambiguous' });
      ambiguous.state.handler = 'throw';
      const failed = await (await ambiguous.runner()).run({ jobId: ambiguousJobId });
      expect(failed.kind).toBe('settled');
      expect(failed.kind === 'settled' && failed.cause).toBe('ambiguous_failure');
      expect(failed.job.job.state).toBe('dead_lettered');
      expect(failed.job.job.lease).toBeNull();
      expect(ambiguous.jobs.readLatestDisposition(ambiguousJobId)).toMatchObject({
        disposition: retryPolicy === 'anchor_inspection_only' ? 'reconcile' : 'block'
      });
      expect(ambiguous.jobs.listAttemptEvidence(ambiguousJobId)[0]?.completion?.failure)
        .toMatchObject({ classification: 'ambiguous' });

      const timeout = await harness({ externalRetryPolicy: retryPolicy, timeoutMs: 1_000 });
      const timeoutJobId = timeout.createJob({ inputMessage: 'timeout' });
      timeout.state.handler = 'timeout';
      const timedOut = await (await timeout.runner()).run({ jobId: timeoutJobId });
      expect(timedOut.kind).toBe('settled');
      expect(timedOut.kind === 'settled' && timedOut.cause).toBe('timeout');
      expect(timeout.jobs.readLatestDisposition(timeoutJobId)).toMatchObject({
        cause: 'timeout',
        disposition: retryPolicy === 'anchor_inspection_only' ? 'reconcile' : 'block'
      });
      expect(timeout.jobs.listAttemptEvidence(timeoutJobId)).toHaveLength(1);

      const expired = await harness({ externalRetryPolicy: retryPolicy });
      const expiredJobId = expired.createJob({ inputMessage: 'expired' });
      const expiredRunner = await expired.runner();
      await expect(expiredRunner.run({
        jobId: expiredJobId,
        faults: { afterClaimed: () => { throw new Error('worker-crash'); } }
      })).rejects.toThrow('worker-crash');
      expired.clock.advance(30_001);
      const takeover = await (await expired.runner({ workerKey: 'worker.registered-job-b' }))
        .run({ jobId: expiredJobId });
      expect(takeover.kind).toBe('settled');
      expect(takeover.kind === 'settled' && takeover.cause).toBe('lease_expired');
      expect(expired.jobs.listAttemptEvidence(expiredJobId)).toHaveLength(1);
      expect(expired.jobs.readLatestDisposition(expiredJobId)).toMatchObject({
        cause: 'lease_expired',
        disposition: retryPolicy === 'anchor_inspection_only' ? 'reconcile' : 'block'
      });
    }
  });

  test('payload-selected execution authority is rejected and composition mismatches fail closed', async () => {
    const test = await harness();
    const inputRef = createPayloadRef(parsePayloadRefId(nextUuid()));
    expect(() => test.inputs.append({
      job: refs.job,
      inputRef,
      value: {
        message: 'attempted substitution',
        targetOperation: 'another.operation',
        capabilityRevisionId: nextUuid(),
        authorityCitationId: nextUuid()
      }
    })).toThrow(RegisteredJobOperationTrialError);

    const mismatchedProjector: RegisteredJobInputProjectionRegistration = {
      ...test.projectors[0]!,
      operationInputSchema: { ...appRefs.input, digestSha256: 'f'.repeat(64) }
    };
    await expect(createSQLiteRegisteredJobOperationTrialRunner({
      sqlite: test.sqlite,
      operationRegistry: test.operationRegistry,
      reliabilityRegistry: test.reliabilityRegistry,
      reliability: test.jobs,
      inputs: test.inputs,
      inputSchemas: test.inputSchemas,
      inputProjectors: [mismatchedProjector],
      dispositionPolicies: [test.policy],
      domain: test.domain,
      transactionAuthority: test.transactionAuthority,
      workerKey: 'worker.registered-job-a',
      newAttemptId: test.nextAttemptId,
      newCorrelationId: test.nextCorrelationId
    })).rejects.toMatchObject({ code: 'composition_mismatch' });

    const forgedPolicy = {
      ...test.policy,
      operationNonterminal: { disposition: 'attention' as const, reasonCode: 'changed' }
    };
    await expect(createSQLiteRegisteredJobOperationTrialRunner({
      sqlite: test.sqlite,
      operationRegistry: test.operationRegistry,
      reliabilityRegistry: test.reliabilityRegistry,
      reliability: test.jobs,
      inputs: test.inputs,
      inputSchemas: test.inputSchemas,
      inputProjectors: test.projectors,
      dispositionPolicies: [forgedPolicy],
      domain: test.domain,
      transactionAuthority: test.transactionAuthority,
      workerKey: 'worker.registered-job-a',
      newAttemptId: test.nextAttemptId,
      newCorrelationId: test.nextCorrelationId
    })).rejects.toMatchObject({ code: 'composition_mismatch' });
  });
});
