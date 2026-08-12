import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createEffectInvocationContextBuilder,
  createHmacRequestHashSealer,
  createOperationAutonomyPolicy,
  createOperationRegistry,
  createSingleUnitOfWorkConformanceFixture,
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
  parseAuthorityCitationId,
  parseCapabilityRevisionId,
  parseContractVersion,
  parseEventId,
  parseInstant,
  parseInvocationId,
  parseJobId,
  parseSourceConnectionId,
  parseSourceConnectionRevisionId,
  parseVerifierRevisionId,
  parseWorkspaceId,
  type Clock,
  type Instant,
  type JobId
} from '@jooevents/kernel';
import {
  buildReliabilityRegistry,
  definitionRef,
  parseCanonicalSha256,
  parseDefinitionKey,
  schemaRef,
  sealReliabilityDefinition,
  type JobDefinition
} from '@jooevents/reliability';
import {
  installFoundationTrialUnitOfWorkSchema,
  type SQLiteTrialEffectDomainAdapter
} from './foundation-trial-uow';
import {
  createSQLiteRegisteredJobOperationTrialRunner,
  installSQLiteRegisteredJobOperationTrial,
  sealRegisteredJobOperationTrialDispositionPolicy,
  SQLiteRegisteredJobInputTrial,
  type RegisteredJobInputProjectionRegistration,
  type RegisteredJobInputSchemaRegistration
} from './registered-job-operation-trial';
import {
  installSQLiteReliabilityJobTrial,
  SQLiteReliabilityJobTrial
} from './reliability-job-trial';
import { installSQLiteVerifiedInboxTrial } from './verified-inbox-trial';
import {
  createSQLiteVerifiedInboxProcessingRunnerTrial,
  installSQLiteVerifiedInboxProcessingTrial,
  sealVerifiedInboxDependencyDeferPolicyTrial,
  sealVerifiedInboxProcessorDefinitionTrial,
  SQLiteVerifiedInboxProcessingTrial,
  VerifiedInboxPreparedSnapshotsTrial,
  withVerifiedInboxProcessingTerminalReduction,
  type VerifiedInboxProcessingDependencyPortTrial,
  type VerifiedInboxProcessorDefinitionTrial
} from './verified-inbox-processing-trial';

const DIGEST_JOB_INPUT = '1'.repeat(64);
const DIGEST_OPERATION_INPUT = '2'.repeat(64);
const DIGEST_RESULT = '3'.repeat(64);
const DIGEST_ERROR = '4'.repeat(64);
const DIGEST_CANONICAL = '5'.repeat(64);
const DIGEST_CONTRIBUTION = '6'.repeat(64);
const DIGEST_DETAIL = '7'.repeat(64);
const CLASSIFIED_CANARY = 'classified-provider-body-Q9v7';

const ids = Object.freeze({
  workspace: parseWorkspaceId('550e8400-e29b-41d4-a716-446655440000'),
  event: parseEventId('550e8400-e29b-41d4-a716-446655440001'),
  source: parseSourceConnectionId('550e8400-e29b-41d4-a716-446655440002'),
  sourceRevision: parseSourceConnectionRevisionId('550e8400-e29b-41d4-a716-446655440003'),
  verifierRevision: parseVerifierRevisionId('550e8400-e29b-41d4-a716-446655440004'),
  capability: parseCapabilityRevisionId('018f0f47-7a86-7d36-8a25-9f86589c0001'),
  schedulerCapability: parseCapabilityRevisionId('018f0f47-7a86-7d36-8a25-9f86589c0002'),
  citation: parseAuthorityCitationId('018f0f47-7a86-7d36-8a25-9f86589c0003')
});

const refs = Object.freeze({
  processor: definitionRef('inbox_processor', 'fake.verified-event', 1),
  receiptSource: definitionRef('inbox_receipt', 'fake.verified-event-receipt', 1),
  job: definitionRef('job', 'fake.verified-event-processing', 1),
  source: definitionRef('source', 'fake.verified-event-source', 1),
  scopeCausation: definitionRef('scope_causation', 'fake.inbox-receipt-scope', 1),
  inputProjection: definitionRef('input_projection', 'fake.processing-ref-input', 1),
  operation: definitionRef('operation', 'fake.process-verified-event', 1),
  authorityCitation: definitionRef('authority_citation', 'fake.inbox-processor-authority', 1),
  backoff: definitionRef('backoff', 'fake.inbox-dependency-backoff', 1),
  cancellation: definitionRef('cancellation', 'fake.inbox-processing-cancellation', 1),
  disposition: definitionRef('job_disposition', 'fake.inbox-processing-disposition', 1),
  dependencyPolicy: definitionRef('inbox_dependency_policy', 'fake.inbox-dependency', 1),
  schedulerAction: definitionRef('scheduler_action', 'fake.discover-inbox-processing', 1)
});

const reliabilitySchemas = Object.freeze({
  input: schemaRef('schema.fake.processing-job-input', 1, DIGEST_JOB_INPUT),
  result: schemaRef('schema.fake.processing-result', 1, DIGEST_RESULT),
  error: schemaRef('schema.fake.processing-error', 1, DIGEST_ERROR)
});

const appRefs = Object.freeze({
  input: {
    key: 'schema.fake.processing-operation-input', version: 1, digestSha256: DIGEST_OPERATION_INPUT
  } satisfies SafeSchemaManifestRef,
  result: {
    key: reliabilitySchemas.result.key,
    version: reliabilitySchemas.result.version,
    digestSha256: reliabilitySchemas.result.canonicalSchemaDigestSha256
  } satisfies SafeSchemaManifestRef,
  canonical: { key: 'schema.fake.processing-canonical', version: 1, digestSha256: DIGEST_CANONICAL },
  contribution: {
    key: 'schema.fake.processing-contribution', version: 1, digestSha256: DIGEST_CONTRIBUTION
  },
  detail: { key: 'schema.fake.processing-detail', version: 1, digestSha256: DIGEST_DETAIL },
  autonomy: { key: 'autonomy.fake-inbox-processing', version: 1 },
  context: { key: 'context.fake-inbox-processing', version: 1 },
  handler: { key: 'handler.fake-inbox-processing', version: 1 },
  handlerCapability: { key: 'capability.fake-inbox-processing', version: 1 },
  projection: { key: 'projection.fake-inbox-processing', version: 1 },
  keySource: { key: 'idempotency.registered-job', version: 1 },
  requestHash: { key: 'request-hash.fake-inbox-processing', version: 1 },
  concurrency: { key: 'concurrency.fake-inbox-processing', version: 1 },
  audit: { key: 'audit.fake-inbox-processing', version: 1 },
  auditRecord: { key: 'audit-record.canonical-json', version: 1 }
});

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

function parse<Value>(schema: OperationSchema, value: unknown): Value {
  const result = schema.safeParse(value);
  if (!result.success) throw new TypeError('test schema rejected a value');
  return result.data as Value;
}

const processingInputSchema = parser((value) => {
  const candidate = record(value);
  return candidate
    && Object.keys(candidate).length === 1
    && typeof candidate.processingRef === 'string'
    && /^vipr1_[A-Za-z0-9_-]{43}$/.test(candidate.processingRef)
    ? { processingRef: candidate.processingRef }
    : undefined;
});

const canonicalSchema = parser((value) => {
  const candidate = record(value);
  if (candidate?.kind === 'success') {
    const data = record(candidate.data);
    if (data && Object.keys(data).join(',') === 'processingRef'
      && typeof data.processingRef === 'string') {
      return { kind: 'success', data: { processingRef: data.processingRef } };
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
  const domain = processingInputSchema.safeParse(candidate?.domain);
  if (
    !candidate
    || !result.success
    || !domain.success
    || !Array.isArray(candidate.receiptChildren)
    || candidate.receiptChildren.length !== 0
  ) return undefined;
  return structuredClone(candidate);
});

const nullSchema = parser((value) => value === null ? null : undefined);

function appRef(key: string): VersionedDefinitionRef {
  return { key, version: 1 };
}

async function sha256(value: string): Promise<string> {
  const hashed = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hashed), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

class TrialClock implements Clock {
  constructor(private value = Date.parse('2026-08-11T00:00:00.000Z')) {}
  now(): Instant { return parseInstant(new Date(this.value).toISOString()); }
  advance(durationMs: number): void { this.value += durationMs; }
}

let uuidCounter = 100;
function nextUuid(): string {
  return `018f0f47-7a86-7d36-8a25-${String(uuidCounter++).padStart(12, '0')}`;
}

function count(sqlite: Database, table: string): number {
  return sqlite.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`).get()?.count ?? -1;
}

async function createHarness(options: {
  readonly maximumPageSize?: number;
  readonly dependencyAttempts?: number;
  readonly dependencyElapsedMs?: number;
  readonly sqlite?: Database;
  readonly installSchema?: boolean;
} = {}) {
  const sqlite = options.sqlite ?? new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  if (options.installSchema !== false) {
    installFoundationTrialUnitOfWorkSchema(sqlite);
    installSQLiteReliabilityJobTrial(sqlite);
    installSQLiteRegisteredJobOperationTrial(sqlite);
    installSQLiteVerifiedInboxTrial(sqlite);
    installSQLiteVerifiedInboxProcessingTrial(sqlite);
    sqlite.exec(`
      CREATE TABLE fake_processed_inbox_events_trial (
        processing_ref TEXT PRIMARY KEY
      ) STRICT;
    `);
  }
  const clock = new TrialClock();
  const jobs = new SQLiteReliabilityJobTrial(sqlite, clock);
  const jobDefinition = await sealReliabilityDefinition({
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
    maximumAttempts: options.dependencyAttempts ?? 2,
    backoff: refs.backoff,
    timeoutMs: 10_000,
    cancellation: refs.cancellation,
    externalRetryPolicy: 'anchor_inspection_only'
  });
  const dependencyPolicy = sealVerifiedInboxDependencyDeferPolicyTrial({
    reference: refs.dependencyPolicy,
    maximumAttempts: options.dependencyAttempts ?? 2,
    maximumElapsedMs: options.dependencyElapsedMs ?? 10_000,
    retryDelayMs: 1_000,
    exhaustion: 'attention'
  });
  const definition = sealVerifiedInboxProcessorDefinitionTrial({
    reference: refs.processor,
    sourceConnectionId: ids.source,
    sourceConnectionRevisionId: ids.sourceRevision,
    verifierContract: { key: 'fake.hmac.verifier', version: 1 },
    verifierRevisionId: ids.verifierRevision,
    receiptSource: refs.receiptSource,
    job: refs.job,
    jobDefinitionDigestSha256: jobDefinition.canonicalDigestSha256,
    schedulerAction: refs.schedulerAction,
    schedulerCapabilityRevisionId: ids.schedulerCapability,
    dependencyPolicy
  });
  const reliabilityRegistry = await buildReliabilityRegistry([jobDefinition]);
  const dispositionPolicy = await sealRegisteredJobOperationTrialDispositionPolicy({
    reference: refs.disposition,
    operationNonterminal: {
      disposition: 'safe_retry', reasonCode: 'inbox.operation_deferred', retryDelayMs: 1_000
    },
    knownPreSubmissionFailure: {
      disposition: 'safe_retry', reasonCode: 'inbox.dependency_deferred', retryDelayMs: 1_000
    },
    retryExhausted: { disposition: 'attention', reasonCode: 'inbox.dependency_exhausted' },
    ambiguous: {
      anchorInspectionOnly: { disposition: 'reconcile', reasonCode: 'inbox.reconcile_required' },
      forbidden: { disposition: 'block', reasonCode: 'inbox.retry_forbidden' }
    }
  });
  const inputSchemas: readonly RegisteredJobInputSchemaRegistration[] = [{
    job: refs.job,
    inputSchema: reliabilitySchemas.input,
    schema: processingInputSchema
  }];
  const inputs = new SQLiteRegisteredJobInputTrial(sqlite, inputSchemas);
  const processingOptions = {
    definition,
    jobDefinition,
    authorityCitationId: ids.citation,
    jobDispositionPolicy: dispositionPolicy,
    cursorKeyBytes: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
    enqueueKeyBytes: Uint8Array.from({ length: 32 }, (_, index) => index + 41),
    maximumPageSize: options.maximumPageSize ?? 2,
    clock,
    jobs,
    inputs,
    newJobId: nextUuid,
    newInputRefId: nextUuid,
    newCandidateId: nextUuid
  } as const;
  const createProcessingStore = () =>
    new SQLiteVerifiedInboxProcessingTrial(sqlite, processingOptions);
  const processing = createProcessingStore();
  const preparations = new VerifiedInboxPreparedSnapshotsTrial();
  const trace: string[] = [];
  const lane = parseOperationAccessLane({
    kind: 'registered_job',
    surface: 'application_job',
    policy: { key: 'authority.fake-inbox-processing', version: 1 }
  });
  const profile = { key: 'fake-inbox-processing', version: parseContractVersion(1) };
  const contextBuilder = createEffectInvocationContextBuilder({
    reference: appRefs.context,
    operation: { name: refs.operation.key, version: refs.operation.version },
    effect: 'commit',
    lanes: [lane],
    scopeResolver: {
      resolve: ({ evidence }) => {
        if (evidence.kind !== 'registered_job') throw new TypeError('registered job evidence required');
        const record = jobs.require(evidence.jobId);
        return {
          workspaceId: record.scope.workspaceId,
          eventId: record.scope.eventId,
          subjects: [
            { kind: 'workspace' as const, id: record.scope.workspaceId },
            { kind: 'event' as const, id: record.scope.eventId }
          ],
          resolutionEvidenceIds: [`inbox-job-scope:${record.job.id}`]
        };
      }
    },
    authorityResolver: {
      resolve: (resolution) => {
        if (resolution.evidence.kind !== 'registered_job') {
          return { kind: 'denied' as const, reason: 'lane_mismatch' as const };
        }
        const record = jobs.require(resolution.evidence.jobId);
        const lease = record.job.lease;
        if (
          record.job.state !== 'leased'
          || !lease
          || record.job.capabilityRevisionId !== jobDefinition.capabilityRevisionId
          || !sameRef(record.job.authorityCitation, jobDefinition.authorityCitation)
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
            evidenceIds: [`inbox-job-current:${record.job.id}:${lease.attemptId}`],
            authorityCitationIds: [record.authorityCitationId],
            evaluatedAt: resolution.evaluatedAt
          }
        };
      }
    },
    clock,
    newInvocationId: () => parseInvocationId(nextUuid()),
    authorityPrincipalKeyProfile: profile,
    scopePartitionProfile: profile,
    requestCanonicalizationProfile: profile,
    idempotencyCredentialProfile: profile,
    idempotencyCredentialSealer: {
      async seal(rawIdempotencyKey) {
        return { verifierProfile: profile, verifierSha256: await sha256(rawIdempotencyKey) };
      }
    },
    requestHashProfile: appRefs.requestHash,
    requestHashSealer: createHmacRequestHashSealer({
      profile: appRefs.requestHash,
      keyBytes: new Uint8Array(32).fill(0x3c)
    }),
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
      { reference: appRefs.input, schema: processingInputSchema },
      { reference: appRefs.result, schema: effectfulOperationResultSchema },
      { reference: appRefs.canonical, schema: canonicalSchema },
      { reference: appRefs.contribution, schema: contributionSchema },
      { reference: appRefs.detail, schema: nullSchema }
    ],
    contextBuilders: [],
    readCapabilities: [],
    handlers: [],
    projections: [{
      reference: appRefs.projection,
      canonicalResultSchema: appRefs.canonical,
      projectedResultSchema: appRefs.result,
      project: (candidate) => parse(canonicalSchema, candidate)
    }],
    operations: [],
    effectContextBuilders: [contextBuilder],
    operationAuditTargets: [{
      reference: appRefs.audit,
      kind: 'operation_audit_record',
      recordProfile: appRefs.auditRecord
    }],
    operationAuditRecordProfiles: [{
      reference: appRefs.auditRecord,
      kind: 'canonical_json',
      maximumBytes: 65_536
    }],
    effectHandlers: [{
      reference: appRefs.handler,
      effect: 'commit',
      handlerCapability: appRefs.handlerCapability,
      contributionSchema: appRefs.contribution,
      canonicalResultSchema: appRefs.canonical,
      handle: ({ businessInput, context, snapshot }) => {
        const request = parse<{ processingRef: string }>(processingInputSchema, businessInput);
        const typedContext = context as EffectInvocationContext;
        if (typedContext.authority.principal.kind !== 'registered_job') {
          throw new TypeError('processor operation requires registered job authority');
        }
        expect(record(snapshot)?.prepared).toEqual({ classified: CLASSIFIED_CANARY });
        return {
          result: { kind: 'success' as const, data: request },
          domain: request,
          receiptChildren: []
        };
      }
    }],
    effectOperations: [{
      name: refs.operation.key,
      version: refs.operation.version,
      lifecycle: { status: 'active' },
      summary: 'Process one verified inbox receipt.',
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
        inputProjection: {
          key: refs.inputProjection.key,
          version: refs.inputProjection.version
        },
        capabilityRevisionId: ids.capability,
        authorityCitation: {
          key: refs.authorityCitation.key,
          version: refs.authorityCitation.version
        },
        projection: appRefs.projection
      }]
    }]
  };
  const operationRegistry = await createOperationRegistry(operationSource);
  const projectors: readonly RegisteredJobInputProjectionRegistration[] = [{
    reference: refs.inputProjection,
    jobInputSchema: reliabilitySchemas.input,
    operationInputSchema: appRefs.input,
    project: (candidate) => parse(processingInputSchema, candidate)
  }];
  const baseDomain: SQLiteTrialEffectDomainAdapter = {
    openHandlerSnapshot: (_capability, context) => {
      if (context.authority.principal.kind !== 'registered_job') {
        throw new TypeError('registered job context required');
      }
      return { prepared: preparations.read(context.authority.principal.jobId) };
    },
    applyDomainContribution: (contribution) => {
      const parsed = parse<{ processingRef: string }>(processingInputSchema, contribution);
      sqlite.query('INSERT INTO fake_processed_inbox_events_trial (processing_ref) VALUES (?)')
        .run(parsed.processingRef);
    },
    afterReceiptParentInserted: () => {
      expect(sqlite.inTransaction).toBe(true);
      const head = sqlite.query<{ state: string }, []>(
        'SELECT state FROM verified_inbox_processing_heads_trial'
      ).get();
      const job = sqlite.query<{ state: string }, []>('SELECT state FROM reliability_jobs_trial').get();
      trace.push(`head:${head?.state}:job:${job?.state}`);
    }
  };
  const registeredJobRunner = await createSQLiteRegisteredJobOperationTrialRunner({
    sqlite,
    operationRegistry,
    reliabilityRegistry,
    reliability: jobs,
    inputs,
    inputSchemas,
    inputProjectors: projectors,
    dispositionPolicies: [dispositionPolicy],
    domain: withVerifiedInboxProcessingTerminalReduction(processing, baseDomain),
    workerKey: 'worker.fake-inbox-processor',
    newAttemptId: () => parseInvocationId(nextUuid()),
    newCorrelationId: () => nextUuid(),
    newReceiptId: nextUuid
  });
  const dependencyState: {
    responses: Array<
      | { readonly kind: 'ready'; readonly prepared: unknown }
      | { readonly kind: 'unavailable'; readonly reasonCode: string }
    >;
    calls: number;
    transactionStates: boolean[];
  } = { responses: [], calls: 0, transactionStates: [] };
  const dependency: VerifiedInboxProcessingDependencyPortTrial = {
    async prepare() {
      dependencyState.calls += 1;
      dependencyState.transactionStates.push(sqlite.inTransaction);
      const response = dependencyState.responses.shift();
      if (!response) throw new TypeError('dependency response missing');
      return response;
    }
  };
  const processorRunner = createSQLiteVerifiedInboxProcessingRunnerTrial({
    sqlite,
    processing,
    jobs,
    registeredJobRunner,
    dependency,
    preparations,
    workerKey: 'worker.fake-inbox-processor',
    clock,
    newAttemptId: () => parseInvocationId(nextUuid())
  });

  sqlite.query(`
    INSERT OR IGNORE INTO verified_inbox_source_processor_mappings_trial (
      source_connection_id, source_connection_revision_id,
      verifier_contract_key, verifier_contract_version, verifier_revision_id,
      processor_key, processor_version, processor_digest_sha256, job_key, job_version
    ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
  `).run(
    ids.source,
    ids.sourceRevision,
    definition.verifierContract.key,
    ids.verifierRevision,
    definition.reference.key,
    definition.reference.version,
    definition.canonicalDigestSha256,
    definition.job.key,
    definition.job.version
  );
  const exactMappingCount = sqlite.query<{ total: number }, [string, string, string]>(`
    SELECT count(*) AS total
    FROM verified_inbox_source_processor_mappings_trial
    WHERE source_connection_id = ? AND source_connection_revision_id = ?
      AND processor_digest_sha256 = ?
  `).get(ids.source, ids.sourceRevision, definition.canonicalDigestSha256)?.total ?? 0;
  if (exactMappingCount !== 1) throw new TypeError('source processor mapping changed across restart');

  const seedReceipt = (value: number, createdAtMs = value) => {
    const receiptId = `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
    const pointerId = `00000000-0000-4000-8000-${String(value + 100).padStart(12, '0')}`;
    const payloadRefId = `00000000-0000-4000-8000-${String(value + 200).padStart(12, '0')}`;
    sqlite.transaction(() => {
      sqlite.query(`INSERT INTO verified_inbox_payload_refs_trial
        (payload_ref_id, disposition, recorded_at_ms) VALUES (?, 'adopted', ?)`)
        .run(payloadRefId, createdAtMs);
      sqlite.query(`INSERT INTO verified_inbox_receipts_trial (
        receipt_id, source_connection_id, source_connection_revision_id,
        semantic_identity, verifier_revision_id, adopted_payload_ref_id,
        workspace_id, event_id, received_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          receiptId, ids.source, ids.sourceRevision,
          `si1_${String(value).padStart(32, 'A')}`,
          ids.verifierRevision, payloadRefId, ids.workspace, ids.event, createdAtMs
        );
      sqlite.query(`INSERT INTO verified_inbox_receipt_processing_contracts_trial (
        receipt_id, source_connection_id, source_connection_revision_id,
        verifier_contract_key, verifier_contract_version, verifier_revision_id,
        processor_key, processor_version, processor_digest_sha256, job_key, job_version
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`)
        .run(
          receiptId, ids.source, ids.sourceRevision, definition.verifierContract.key,
          ids.verifierRevision, definition.reference.key, definition.reference.version,
          definition.canonicalDigestSha256, definition.job.key, definition.job.version
        );
      sqlite.query(`INSERT INTO verified_inbox_processing_pointers_trial
        (processing_pointer_id, receipt_id, created_at_ms) VALUES (?, ?, ?)`)
        .run(pointerId, receiptId, createdAtMs);
    })();
    return { receiptId, pointerId, payloadRefId };
  };
  const seedChangedConflict = (receiptId: string, value: number) => {
    const conflictId = `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
    const payloadRefId = `00000000-0000-4000-8000-${String(value + 200).padStart(12, '0')}`;
    const attentionId = `00000000-0000-4000-8000-${String(value + 300).padStart(12, '0')}`;
    sqlite.transaction(() => {
      sqlite.query(`INSERT INTO verified_inbox_payload_refs_trial
        (payload_ref_id, disposition, recorded_at_ms) VALUES (?, 'quarantined', ?)`)
        .run(payloadRefId, value);
      sqlite.query(`INSERT INTO verified_inbox_conflicts_trial (
        conflict_id, receipt_id, source_connection_revision_id, verifier_revision_id,
        quarantined_payload_ref_id, observed_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(conflictId, receiptId, ids.sourceRevision, ids.verifierRevision, payloadRefId, value);
      sqlite.query(`INSERT INTO verified_inbox_attentions_trial
        (attention_id, conflict_id, created_at_ms) VALUES (?, ?, ?)`)
        .run(attentionId, conflictId, value);
    })();
  };
  return {
    sqlite,
    clock,
    definition,
    jobDefinition,
    jobs,
    processing,
    createProcessingStore,
    processorRunner,
    dependencyState,
    trace,
    seedReceipt,
    seedChangedConflict
  };
}

function sameRef(
  left: { readonly key: string; readonly version: number },
  right: { readonly key: string; readonly version: number }
): boolean {
  return left.key === right.key && left.version === right.version;
}

describe('disposable verified inbox discovery, enqueue, and processing join', () => {
  test('bounds signed cursor discovery and treats candidates as non-authority evidence', async () => {
    const trial = await createHarness({ maximumPageSize: 1 });
    trial.seedReceipt(1, 10);
    trial.seedReceipt(2, 20);
    const first = trial.processing.list();
    expect(first.candidates).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    expect(Object.keys(first.candidates[0] ?? {})).toEqual(['id']);
    const second = trial.processing.list(first.nextCursor ?? undefined);
    expect(second.candidates).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const tampered = Object.freeze({
      value: `${first.nextCursor?.value.slice(0, -1)}x`
    });
    expect(() => trial.processing.list(tampered)).toThrow(/cursor is invalid/);
    const clone = structuredClone(first.candidates[0]);
    expect(() => trial.processing.enqueue(clone as never)).toThrow(/authentic discovery evidence/);
    const plan = trial.sqlite.query<{ detail: string }, [string, string, string, number, string, number]>(`
      EXPLAIN QUERY PLAN
      SELECT p.processing_pointer_id, p.receipt_id, p.created_at_ms
      FROM verified_inbox_processing_pointers_trial p
      WHERE EXISTS (
        SELECT 1 FROM verified_inbox_receipt_processing_contracts_trial c
        WHERE c.receipt_id = p.receipt_id
          AND c.source_connection_id = ? AND c.source_connection_revision_id = ?
          AND c.processor_key = ? AND c.processor_version = ?
          AND c.processor_digest_sha256 = ?
      ) AND NOT EXISTS (
        SELECT 1 FROM verified_inbox_processing_heads_trial h
        WHERE h.receipt_id = p.receipt_id
      )
      ORDER BY p.created_at_ms, p.processing_pointer_id
      LIMIT ?
    `).all(
      ids.source,
      ids.sourceRevision,
      trial.definition.reference.key,
      trial.definition.reference.version,
      trial.definition.canonicalDigestSha256,
      2
    );
    expect(plan.some(({ detail }) =>
      detail.includes('SCAN p USING INDEX verified_inbox_processing_discovery_trial')
    )).toBe(true);
    expect(plan.some(({ detail }) => detail.includes('TEMP B-TREE'))).toBe(false);
  });

  test('atomically enqueues once with a stable receipt identity and opaque-only job input', async () => {
    const trial = await createHarness();
    const receipt = trial.seedReceipt(3, 30);
    trial.seedChangedConflict(receipt.receiptId, 400);
    expect(count(trial.sqlite, 'verified_inbox_conflicts_trial')).toBe(1);
    expect(count(trial.sqlite, 'verified_inbox_processing_pointers_trial')).toBe(1);
    const candidate = trial.processing.list().candidates[0];
    const competingStore = trial.createProcessingStore();
    const competingCandidate = competingStore.list().candidates[0];
    if (!candidate || !competingCandidate) throw new TypeError('candidate missing');
    const first = trial.processing.enqueue(candidate);
    const replay = competingStore.enqueue(competingCandidate);
    expect(first.kind).toBe('enqueued');
    expect(replay.kind).toBe('existing');
    expect(replay.head.jobId).toBe(first.head.jobId);
    expect(count(trial.sqlite, 'reliability_jobs_trial')).toBe(1);
    expect(count(trial.sqlite, 'registered_job_inputs_trial')).toBe(1);
    expect(count(trial.sqlite, 'verified_inbox_processing_heads_trial')).toBe(1);
    expect(trial.processing.list().candidates).toHaveLength(0);
    const durable = trial.jobs.require(first.head.jobId);
    expect(durable.job.source.definition).toEqual(refs.receiptSource);
    expect(durable.job.targetOperation).toEqual(refs.operation);
    expect(durable.job.capabilityRevisionId).toBe(ids.capability);
    expect(durable.job.authorityCitation).toEqual(refs.authorityCitation);
    expect(durable.scope).toEqual({ kind: 'event', workspaceId: ids.workspace, eventId: ids.event });
    const stored = trial.sqlite.query<{ input_json: string }, []>(
      'SELECT input_json FROM registered_job_inputs_trial'
    ).get()?.input_json ?? '';
    expect(JSON.parse(stored)).toEqual({ processingRef: first.head.processingRef });
    expect(stored).not.toContain(receipt.receiptId);
    expect(stored).not.toContain(receipt.payloadRefId);
    expect(JSON.stringify(durable.job)).not.toContain(ids.citation);
  });

  test('rolls every enqueue write back and converges after committed response loss', async () => {
    const trial = await createHarness();
    trial.seedReceipt(4, 40);
    const candidate = trial.processing.list().candidates[0];
    if (!candidate) throw new TypeError('candidate missing');
    expect(() => trial.processing.enqueue(candidate, {
      afterJobInserted: () => { throw new Error('crash-after-job'); }
    })).toThrow('crash-after-job');
    expect(count(trial.sqlite, 'registered_job_inputs_trial')).toBe(0);
    expect(count(trial.sqlite, 'reliability_jobs_trial')).toBe(0);
    expect(count(trial.sqlite, 'verified_inbox_processing_heads_trial')).toBe(0);
    expect(() => trial.processing.enqueue(candidate, {
      afterCommit: () => { throw new Error('response-lost-after-enqueue'); }
    })).toThrow('response-lost-after-enqueue');
    const recovered = trial.processing.enqueue(candidate);
    expect(recovered.kind).toBe('existing');
    expect(count(trial.sqlite, 'reliability_jobs_trial')).toBe(1);
    expect(count(trial.sqlite, 'verified_inbox_processing_heads_trial')).toBe(1);
  });

  test('reopens durable enqueue and processor crashes without duplicate work', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'jooevents-inbox-processing-trial-'));
    const databasePath = join(directory, 'processing.sqlite');
    let sqlite: Database | undefined;
    try {
      sqlite = new Database(databasePath, { create: true, strict: true });
      let trial = await createHarness({ sqlite });
      trial.seedReceipt(41, 41);
      const candidate = trial.processing.list().candidates[0];
      if (!candidate) throw new TypeError('candidate missing');
      expect(() => trial.processing.enqueue(candidate, {
        afterCommit: () => { throw new Error('enqueue-response-lost-before-restart'); }
      })).toThrow('enqueue-response-lost-before-restart');
      const jobId = parseJobId(trial.sqlite.query<{ job_id: string }, []>(`
        SELECT job_id FROM verified_inbox_processing_heads_trial
      `).get()?.job_id ?? '');
      expect(count(trial.sqlite, 'reliability_jobs_trial')).toBe(1);
      sqlite.close();
      sqlite = undefined;

      sqlite = new Database(databasePath, { create: false, strict: true });
      trial = await createHarness({ sqlite, installSchema: false });
      expect(trial.processing.list().candidates).toHaveLength(0);
      expect(trial.processing.requireHeadByJob(jobId).state).toBe('queued');
      trial.dependencyState.responses.push({
        kind: 'ready', prepared: { classified: CLASSIFIED_CANARY }
      });
      await expect(trial.processorRunner.run({
        jobId,
        faults: {
          registeredJob: {
            afterAtomicJobCompletion: () => { throw new Error('processor-crash-before-commit'); }
          }
        }
      })).rejects.toThrow('processor-crash-before-commit');
      expect(trial.processing.requireHeadByJob(jobId).state).toBe('queued');
      expect(count(trial.sqlite, 'foundation_trial_operation_receipts')).toBe(0);
      expect(count(trial.sqlite, 'fake_processed_inbox_events_trial')).toBe(0);
      sqlite.close();
      sqlite = undefined;

      sqlite = new Database(databasePath, { create: false, strict: true });
      trial = await createHarness({ sqlite, installSchema: false });
      trial.dependencyState.responses.push({
        kind: 'ready', prepared: { classified: CLASSIFIED_CANARY }
      });
      expect((await trial.processorRunner.run({ jobId })).kind).toBe('terminal');
      expect(trial.processing.requireHeadByJob(jobId).state).toBe('succeeded');
      expect(count(trial.sqlite, 'reliability_jobs_trial')).toBe(1);
      expect(count(trial.sqlite, 'reliability_job_attempts_trial')).toBe(1);
      expect(count(trial.sqlite, 'foundation_trial_operation_receipts')).toBe(1);
      expect(count(trial.sqlite, 'fake_processed_inbox_events_trial')).toBe(1);
    } finally {
      sqlite?.close();
      rmSync(directory, { recursive: true });
    }
  });

  test('rechecks unavailable dependencies outside SQL and exhausts into durable attention', async () => {
    const trial = await createHarness({ dependencyAttempts: 2 });
    trial.seedReceipt(5, 50);
    const candidate = trial.processing.list().candidates[0];
    if (!candidate) throw new TypeError('candidate missing');
    const jobId = trial.processing.enqueue(candidate).head.jobId;
    trial.dependencyState.responses.push(
      { kind: 'unavailable', reasonCode: 'inbox.blob_unavailable' },
      { kind: 'unavailable', reasonCode: 'inbox.blob_unavailable' }
    );
    const first = await trial.processorRunner.run({ jobId });
    expect(first.kind).toBe('deferred');
    expect(trial.jobs.require(jobId).job.state).toBe('retry_wait');
    trial.clock.advance(1_001);
    const second = await trial.processorRunner.run({ jobId });
    expect(second.kind).toBe('requires_attention');
    expect(trial.jobs.require(jobId).job.state).toBe('dead_lettered');
    expect(trial.processing.requireHeadByJob(jobId).state).toBe('attention');
    expect(count(trial.sqlite, 'verified_inbox_processing_dependency_events_trial')).toBe(2);
    const attention = trial.sqlite.query<{
      policy_key: string; policy_version: number; policy_digest_sha256: string;
      disposition: string; next_action_at_ms: number | null;
    }, []>(`
      SELECT policy_key, policy_version, policy_digest_sha256, disposition, next_action_at_ms
      FROM verified_inbox_processing_dependency_events_trial
      ORDER BY observed_at_ms DESC LIMIT 1
    `).get();
    expect(attention).toEqual({
      policy_key: trial.definition.dependencyPolicy.reference.key,
      policy_version: trial.definition.dependencyPolicy.reference.version,
      policy_digest_sha256: trial.definition.dependencyPolicy.canonicalDigestSha256,
      disposition: 'attention',
      next_action_at_ms: null
    });
    const calls = trial.dependencyState.calls;
    expect((await trial.processorRunner.run({ jobId })).kind).toBe('requires_attention');
    expect(trial.dependencyState.calls).toBe(calls);
    expect(trial.dependencyState.transactionStates).toEqual([false, false]);
  });

  test('uses the frozen elapsed-time bound to stop at the first unavailable dependency', async () => {
    const trial = await createHarness({ dependencyAttempts: 5, dependencyElapsedMs: 500 });
    trial.seedReceipt(51, 51);
    const candidate = trial.processing.list().candidates[0];
    if (!candidate) throw new TypeError('candidate missing');
    const jobId = trial.processing.enqueue(candidate).head.jobId;
    trial.dependencyState.responses.push({
      kind: 'unavailable', reasonCode: 'inbox.secret_unavailable'
    });
    const result = await trial.processorRunner.run({ jobId });
    expect(result.kind).toBe('requires_attention');
    expect(trial.dependencyState.calls).toBe(1);
    expect(trial.processing.requireHeadByJob(jobId).state).toBe('attention');
    expect(trial.jobs.require(jobId).job.state).toBe('dead_lettered');
    expect(trial.sqlite.query<{ disposition: string; next_action_at_ms: number | null }, []>(`
      SELECT disposition, next_action_at_ms
      FROM verified_inbox_processing_dependency_events_trial
    `).get()).toEqual({ disposition: 'attention', next_action_at_ms: null });
  });

  test('detaches and recursively freezes prepared dependency snapshots', () => {
    const snapshots = new VerifiedInboxPreparedSnapshotsTrial();
    const jobId = parseJobId(nextUuid());
    const prepared = { classified: { value: 'before' }, sequence: [{ ordinal: 1 }] };
    snapshots.set(jobId, prepared);
    prepared.classified.value = 'after';
    prepared.sequence[0]!.ordinal = 2;
    const frozen = snapshots.read(jobId) as {
      readonly classified: { readonly value: string };
      readonly sequence: readonly [{ readonly ordinal: number }];
    };
    expect(frozen).toEqual({ classified: { value: 'before' }, sequence: [{ ordinal: 1 }] });
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.classified)).toBe(true);
    expect(Object.isFrozen(frozen.sequence)).toBe(true);
    expect(Object.isFrozen(frozen.sequence[0])).toBe(true);
  });

  test('shares processor success with the authentic receipt/job transaction and replays response loss', async () => {
    const trial = await createHarness();
    trial.seedReceipt(6, 60);
    const candidate = trial.processing.list().candidates[0];
    if (!candidate) throw new TypeError('candidate missing');
    const jobId = trial.processing.enqueue(candidate).head.jobId;
    trial.dependencyState.responses.push({
      kind: 'ready', prepared: { classified: CLASSIFIED_CANARY }
    });
    await expect(trial.processorRunner.run({
      jobId,
      faults: { afterReadyRun: () => { throw new Error('processor-response-lost'); } }
    })).rejects.toThrow('processor-response-lost');
    expect(trial.jobs.require(jobId).job.state).toBe('succeeded');
    expect(trial.processing.requireHeadByJob(jobId).state).toBe('succeeded');
    expect(trial.trace).toEqual(['head:succeeded:job:succeeded']);
    expect(count(trial.sqlite, 'foundation_trial_operation_receipts')).toBe(1);
    expect(count(trial.sqlite, 'fake_processed_inbox_events_trial')).toBe(1);
    const dependencyCalls = trial.dependencyState.calls;
    const replay = await trial.processorRunner.run({ jobId });
    expect(replay.kind).toBe('terminal');
    expect(trial.dependencyState.calls).toBe(dependencyCalls);
    expect(count(trial.sqlite, 'foundation_trial_operation_receipts')).toBe(1);
    expect(count(trial.sqlite, 'reliability_job_attempts_trial')).toBe(1);
    const bytes = trial.sqlite.serialize();
    expect(bytes.includes(Buffer.from(CLASSIFIED_CANARY))).toBe(false);
    expect(bytes.includes(Buffer.from(createHash('sha256').update(CLASSIFIED_CANARY).digest('hex'))))
      .toBe(false);
  });

  test('rolls back processor head, job completion, receipt, and domain state together', async () => {
    const trial = await createHarness();
    trial.seedReceipt(7, 70);
    const candidate = trial.processing.list().candidates[0];
    if (!candidate) throw new TypeError('candidate missing');
    const jobId = trial.processing.enqueue(candidate).head.jobId;
    trial.dependencyState.responses.push(
      { kind: 'ready', prepared: { classified: CLASSIFIED_CANARY } },
      { kind: 'ready', prepared: { classified: CLASSIFIED_CANARY } },
      { kind: 'ready', prepared: { classified: CLASSIFIED_CANARY } }
    );
    await expect(trial.processorRunner.run({
      jobId,
      faults: {
        afterDependencyPrepared: () => { throw new Error('crash-after-dependency-prepared'); }
      }
    })).rejects.toThrow('crash-after-dependency-prepared');
    expect(trial.jobs.require(jobId).job.state).toBe('leased');
    expect(trial.processing.requireHeadByJob(jobId).state).toBe('queued');
    await expect(trial.processorRunner.run({
      jobId,
      faults: {
        registeredJob: {
          afterAtomicJobCompletion: () => { throw new Error('crash-before-processor-head'); }
        }
      }
    })).rejects.toThrow('crash-before-processor-head');
    expect(trial.jobs.require(jobId).job.state).toBe('leased');
    expect(trial.processing.requireHeadByJob(jobId).state).toBe('queued');
    expect(count(trial.sqlite, 'foundation_trial_operation_receipts')).toBe(0);
    expect(count(trial.sqlite, 'fake_processed_inbox_events_trial')).toBe(0);
    const recovered = await trial.processorRunner.run({ jobId });
    expect(recovered.kind).toBe('terminal');
    expect(trial.processing.requireHeadByJob(jobId).state).toBe('succeeded');
    expect(count(trial.sqlite, 'foundation_trial_operation_receipts')).toBe(1);
  });
});
