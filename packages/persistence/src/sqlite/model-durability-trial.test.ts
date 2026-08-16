import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import {
  DeterministicFakeAdapter,
  calculateModelProfileDigest,
  calculateModelScaffoldDigest,
  modelProviderIdempotencyKeyFor,
  parseModelRequestBinding,
  type ModelAttemptRequest,
  type ModelAttemptObservation,
  type ModelAttemptRecord,
  type ModelProfileRevision,
  type ModelRunRecord,
  type ModelScaffoldRevision,
  type ModelToolDefinition
} from '@jooevents/model-adapter';
import {
  createPayloadRef,
  parseAgentRunId,
  parseAuthorityCitationId,
  parseModelAttemptId,
  parseModelToolCallId,
  parseOperationReceiptId,
  parsePayloadRefId,
  parseUtcInstant,
  type PayloadRef
} from '@jooevents/kernel';
import {
  ModelDurabilityTrialRepository,
  SqliteDeterministicFakeTrialStore,
  installModelDurabilityTrial,
  type ModelTrialSealedAttemptReduction,
  type ModelTrialSealedPersistenceOpeners,
  type ModelTrialSealedToolReceiptAttachment,
  type ModelTrialSealedToolResume
} from './model-durability-trial';
import { installFoundationTrialUnitOfWorkSchema } from './foundation-trial-uow';

const opened = new Set<Database>();
const directories = new Set<string>();

afterEach(() => {
  for (const sqlite of opened) sqlite.close();
  opened.clear();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories.clear();
});

const bindingKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const bindingProfile = Object.freeze({ key: 'foundation_model_binding', version: 1 });
const digest = (character: string) => character.repeat(64);
const t0 = parseUtcInstant('2026-08-11T00:00:00Z');
const t1 = parseUtcInstant('2026-08-11T00:01:00Z');
const t2 = parseUtcInstant('2026-08-11T00:02:00Z');
const t3 = parseUtcInstant('2026-08-11T00:03:00Z');

const ids = {
  run1: parseAgentRunId('01890f47-9abc-7def-8123-456789abd001'),
  run2: parseAgentRunId('01890f47-9abc-7def-8123-456789abd002'),
  run3: parseAgentRunId('01890f47-9abc-7def-8123-456789abd003'),
  run4: parseAgentRunId('01890f47-9abc-7def-8123-456789abd004'),
  run5: parseAgentRunId('01890f47-9abc-7def-8123-456789abd005'),
  run6: parseAgentRunId('01890f47-9abc-7def-8123-456789abd006'),
  attempt1: parseModelAttemptId('01890f47-9abc-7def-8123-456789abd011'),
  attempt2: parseModelAttemptId('01890f47-9abc-7def-8123-456789abd012'),
  attempt3: parseModelAttemptId('01890f47-9abc-7def-8123-456789abd013'),
  attempt4: parseModelAttemptId('01890f47-9abc-7def-8123-456789abd014'),
  attempt5: parseModelAttemptId('01890f47-9abc-7def-8123-456789abd015'),
  attempt6: parseModelAttemptId('01890f47-9abc-7def-8123-456789abd016'),
  tool1: parseModelToolCallId('01890f47-9abc-7def-8123-456789abd021'),
  sourceReceipt1: parseOperationReceiptId('01890f47-9abc-7def-8123-456789abd031'),
  sourceReceipt2: parseOperationReceiptId('01890f47-9abc-7def-8123-456789abd032'),
  sourceReceipt3: parseOperationReceiptId('01890f47-9abc-7def-8123-456789abd033'),
  sourceReceipt4: parseOperationReceiptId('01890f47-9abc-7def-8123-456789abd034'),
  sourceReceipt5: parseOperationReceiptId('01890f47-9abc-7def-8123-456789abd035'),
  sourceReceipt6: parseOperationReceiptId('01890f47-9abc-7def-8123-456789abd036'),
  toolReceipt: parseOperationReceiptId('01890f47-9abc-7def-8123-456789abd041'),
  wrongToolReceipt: parseOperationReceiptId('01890f47-9abc-7def-8123-456789abd042'),
  citation: parseAuthorityCitationId('01890f47-9abc-7def-8123-456789abd051'),
  input1: createPayloadRef(parsePayloadRefId('01890f47-9abc-7def-8123-456789abd061')),
  input2: createPayloadRef(parsePayloadRefId('01890f47-9abc-7def-8123-456789abd062')),
  input3: createPayloadRef(parsePayloadRefId('01890f47-9abc-7def-8123-456789abd063')),
  input4: createPayloadRef(parsePayloadRefId('01890f47-9abc-7def-8123-456789abd064')),
  input5: createPayloadRef(parsePayloadRefId('01890f47-9abc-7def-8123-456789abd065')),
  input6: createPayloadRef(parsePayloadRefId('01890f47-9abc-7def-8123-456789abd066')),
  result: createPayloadRef(parsePayloadRefId('01890f47-9abc-7def-8123-456789abd071')),
  toolInput: createPayloadRef(parsePayloadRefId('01890f47-9abc-7def-8123-456789abd072'))
};

interface TrialContext {
  readonly path: string;
  readonly sqlite: Database;
  readonly repository: ModelDurabilityTrialRepository;
  readonly sealed: {
    readonly reductions: WeakMap<object, ModelTrialSealedAttemptReduction>;
    readonly attachments: WeakMap<object, ModelTrialSealedToolReceiptAttachment>;
    readonly resumes: WeakMap<object, ModelTrialSealedToolResume>;
    readonly openers: ModelTrialSealedPersistenceOpeners;
  };
}

function createTrialSeals(): TrialContext['sealed'] {
  const reductions = new WeakMap<object, ModelTrialSealedAttemptReduction>();
  const attachments = new WeakMap<object, ModelTrialSealedToolReceiptAttachment>();
  const resumes = new WeakMap<object, ModelTrialSealedToolResume>();
  return {
    reductions,
    attachments,
    resumes,
    openers: {
      openAttemptReduction: (seal) => reductions.get(seal),
      openToolReceiptAttachment: (seal) => attachments.get(seal),
      openToolResume: (seal) => resumes.get(seal)
    }
  };
}

function freshTrial(): TrialContext {
  const directory = mkdtempSync(join(tmpdir(), 'jooevents-model-trial-'));
  directories.add(directory);
  const path = join(directory, 'model.sqlite');
  const sqlite = new Database(path, { create: true, strict: true });
  opened.add(sqlite);
  installFoundationTrialUnitOfWorkSchema(sqlite);
  installModelDurabilityTrial(sqlite);
  const sealed = createTrialSeals();
  return {
    path,
    sqlite,
    repository: new ModelDurabilityTrialRepository(sqlite, {
      binding: { profile: bindingProfile, keyBytes: bindingKey },
      sealedPersistence: sealed.openers
    }),
    sealed
  };
}

function restartTrial(context: TrialContext): TrialContext {
  context.sqlite.close();
  opened.delete(context.sqlite);
  const sqlite = new Database(context.path, { create: false, strict: true });
  opened.add(sqlite);
  sqlite.exec('PRAGMA foreign_keys = ON');
  return {
    path: context.path,
    sqlite,
    repository: new ModelDurabilityTrialRepository(sqlite, {
      binding: { profile: bindingProfile, keyBytes: bindingKey },
      sealedPersistence: context.sealed.openers
    }),
    sealed: context.sealed
  };
}

function reduceAttempt(
  context: TrialContext,
  input: {
    readonly runId: typeof ids.run1;
    readonly attemptId: typeof ids.attempt1;
    readonly expectedRunVersion: number;
    readonly expectedFence: number;
    readonly observation: ModelAttemptObservation;
    readonly finishedAt: typeof t0;
    readonly adoptedResultRef?: PayloadRef;
  },
  toolCalls: ModelTrialSealedAttemptReduction['toolCalls'] = []
) {
  const run = context.repository.getRun(input.runId);
  const attempt = context.repository.getAttempt(input.attemptId);
  if (!run || !attempt) throw new Error('fixture model work missing');
  const observation = input.observation.kind === 'succeeded'
    ? { ...input.observation, output: input.adoptedResultRef ?? input.observation.output }
    : input.observation;
  const adoptions = observation.kind === 'succeeded'
    ? [{ kind: 'model_result' as const, ordinal: 0, payloadRef: observation.output as PayloadRef }]
    : observation.kind === 'tool_requests'
      ? toolCalls.map((call) => ({
          kind: 'model_tool_input' as const,
          ordinal: call.sequence,
          payloadRef: call.inputPayloadRef,
          call
        }))
      : [];
  for (const adoption of adoptions) {
    context.sqlite.query(`
      INSERT OR IGNORE INTO model_attempt_payload_adoptions_trial (
        payload_ref_id, run_id, attempt_id, attempt_fence, owner_kind, ordinal,
        model_tool_call_id, provider_call_id, operation_name, operation_version,
        stage_id, stage_expected_version, stage_fence, stage_expires_at_ms,
        reconciliation_policy_key, reconciliation_policy_version,
        authentication_profile_key, authentication_profile_version, authentication_tag,
        classification_profile_key, classification_profile_version,
        schema_profile_key, schema_profile_version, content_profile_key, content_profile_version,
        integrity_profile_key, integrity_profile_version,
        descriptor_auth_profile_key, descriptor_auth_profile_version,
        scope_binding, content_type, byte_size, integrity_digest
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?,
        'test_reconciliation', 1, 'test_descriptor_auth', 1, ?,
        'test_classification', 1, 'test_schema', 1, 'test_content', 1,
        'test_integrity', 1, 'test_descriptor_auth', 1,
        ?, 'application/json', 0, ?
      )
    `).run(
      adoption.payloadRef.id,
      run.id,
      attempt.id,
      attempt.fence,
      adoption.kind,
      adoption.ordinal,
      'call' in adoption ? adoption.call.id : null,
      'call' in adoption ? adoption.call.providerCallId : null,
      'call' in adoption ? adoption.call.operation.name : null,
      'call' in adoption ? adoption.call.operation.version : null,
      adoption.payloadRef.id,
      Date.parse(t3),
      digest('a'),
      `test:${run.id}:${attempt.id}:${adoption.kind}:${adoption.ordinal}`,
      digest('b')
    );
  }
  const seal = Object.freeze({});
  context.sealed.reductions.set(seal, {
    runId: run.id,
    attemptId: attempt.id,
    expectedRunVersion: input.expectedRunVersion,
    expectedFence: input.expectedFence,
    requestBinding: attempt.requestBinding,
    profile: run.profile,
    scaffold: run.scaffold,
    adapter: attempt.adapter,
    executionMode: attempt.executionMode,
    providerIdempotencyKey: modelProviderIdempotencyKeyFor(attempt.requestBinding),
    observation,
    finishedAt: input.finishedAt,
    toolCalls
  });
  return context.repository.reduceAttempt(seal);
}

const capabilities = Object.freeze({
  structuredOutput: true,
  tools: true,
  batch: true,
  fast: true,
  lookup: true,
  cancellation: true,
  idempotency: true
});

function profile(version: number): ModelProfileRevision {
  const candidate: ModelProfileRevision = {
    key: 'foundation_fake',
    version,
    digest: digest('0'),
    adapter: { key: 'deterministic_fake', version: 1 },
    modelId: `deterministic-v${version}`,
    controls: { effort: version === 1 ? 'medium' : 'high', maxOutputTokens: 500, requireStructuredOutput: true },
    defaultExecutionMode: 'batch',
    budget: {
      maximumAttempts: 3,
      maxInputTokens: 10_000,
      maxOutputTokens: 2_000,
      maxCostMicros: 10_000,
      timeoutMs: 300_000
    },
    capabilities
  };
  return { ...candidate, digest: calculateModelProfileDigest(candidate) };
}

function scaffold(version: number): ModelScaffoldRevision {
  const candidate: ModelScaffoldRevision = {
    key: 'foundation_probe',
    version,
    digest: digest('0'),
    purpose: 'foundation_probe',
    outputSchema: { key: 'foundation_probe_output', version },
    allowedTools: [{ name: 'foundation.read', version: 1 }]
  };
  return { ...candidate, digest: calculateModelScaffoldDigest(candidate) };
}

function seedCatalog(repository: ModelDurabilityTrialRepository): {
  readonly profile1: ModelProfileRevision;
  readonly profile2: ModelProfileRevision;
  readonly scaffold1: ModelScaffoldRevision;
  readonly scaffold2: ModelScaffoldRevision;
} {
  const profile1 = repository.insertProfileRevision(profile(1));
  const profile2 = repository.insertProfileRevision(profile(2));
  const scaffold1 = repository.insertScaffoldRevision(scaffold(1));
  const scaffold2 = repository.insertScaffoldRevision(scaffold(2));
  repository.pointProfileCurrent({ revision: profile1, expectedPointerVersion: null });
  repository.pointScaffoldCurrent({ revision: scaffold1, expectedPointerVersion: null });
  return { profile1, profile2, scaffold1, scaffold2 };
}

function startRun(
  repository: ModelDurabilityTrialRepository,
  input: {
    readonly runId: typeof ids.run1;
    readonly sourceReceipt: typeof ids.sourceReceipt1;
    readonly classifiedInput: PayloadRef;
  }
): ModelRunRecord {
  return repository.startRun({
    id: input.runId,
    profileKey: 'foundation_fake',
    scaffoldKey: 'foundation_probe',
    sourceOperation: { name: 'foundation.model.start', version: 1, receiptId: input.sourceReceipt },
    scopeKey: 'workspace:01890f47-9abc-7def-8123-456789abcdef',
    authorityCitationId: ids.citation,
    classifiedInputRefs: [input.classifiedInput],
    createdAt: t0
  });
}

function requestFor(
  repository: ModelDurabilityTrialRepository,
  run: ModelRunRecord,
  attempt: ModelAttemptRecord,
  message: string,
  tools: readonly ModelToolDefinition[] = []
): ModelAttemptRequest {
  const profileRevision = repository.getProfile(run.profile);
  const scaffoldRevision = repository.getScaffold(run.scaffold);
  if (!profileRevision || !scaffoldRevision) throw new Error('fixture configuration missing');
  return {
    runId: run.id,
    attemptId: attempt.id,
    requestBinding: attempt.requestBinding,
    profile: profileRevision,
    scaffold: scaffoldRevision,
    messages: [{ role: 'user', content: message }],
    tools,
    outputJsonSchema: { name: 'foundation_probe_output', schema: { type: 'object' }, strict: true },
    executionMode: attempt.executionMode,
    providerIdempotencyKey: modelProviderIdempotencyKeyFor(attempt.requestBinding)
  };
}

function sqliteBytes(sqlite: Database): Buffer {
  return Buffer.from(sqlite.serialize());
}

function expectCanaryAbsent(sqlite: Database, canary: string): void {
  const bytes = sqliteBytes(sqlite);
  const raw = Buffer.from(canary);
  const plainDigest = Buffer.from(createHash('sha256').update(canary).digest('hex'));
  expect(bytes.includes(raw)).toBe(false);
  expect(bytes.includes(plainDigest)).toBe(false);
}

describe('disposable model catalog and run persistence', () => {
  test('immutable revisions, conditional pointers, frozen runs, and batch/fast intent survive restart', () => {
    let context = freshTrial();
    const catalog = seedCatalog(context.repository);

    const applicationTables = context.sqlite.query<{ name: string }, []>(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name
    `).all();
    expect(applicationTables.length).toBeGreaterThan(0);
    expect(applicationTables.map(({ name }) => name)).toEqual(expect.arrayContaining([
      'operation_log',
      'model_profile_revisions_trial',
      'model_profile_current_trial',
      'model_scaffold_revisions_trial',
      'model_scaffold_current_trial',
      'model_binding_profiles_trial',
      'model_runs_trial',
      'model_attempts_trial',
      'model_tool_calls_trial',
      'model_attempt_payload_adoptions_trial',
      'deterministic_fake_attempts_trial',
      'deterministic_fake_tool_requests_trial'
    ]));

    const frozen = startRun(context.repository, {
      runId: ids.run1,
      sourceReceipt: ids.sourceReceipt1,
      classifiedInput: ids.input1
    });
    expect(frozen.profile).toMatchObject({ key: catalog.profile1.key, version: 1, digest: catalog.profile1.digest });
    expect(frozen.scaffold).toMatchObject({ key: catalog.scaffold1.key, version: 1, digest: catalog.scaffold1.digest });

    expect(context.repository.pointProfileCurrent({
      revision: catalog.profile2,
      expectedPointerVersion: 1
    }).pointerVersion).toBe(2);
    expect(context.repository.pointScaffoldCurrent({
      revision: catalog.scaffold2,
      expectedPointerVersion: 1
    }).pointerVersion).toBe(2);
    expect(() => context.repository.pointProfileCurrent({
      revision: catalog.profile1,
      expectedPointerVersion: 1
    })).toThrow('stale_model_profile_pointer');
    expect(context.repository.pointProfileCurrent({
      revision: catalog.profile1,
      expectedPointerVersion: 2
    })).toMatchObject({ pointerVersion: 3, revision: { version: 1, digest: catalog.profile1.digest } });
    expect(context.repository.pointScaffoldCurrent({
      revision: catalog.scaffold1,
      expectedPointerVersion: 2
    })).toMatchObject({ pointerVersion: 3, revision: { version: 1, digest: catalog.scaffold1.digest } });
    expect(() => context.sqlite.query(`
      UPDATE model_profile_revisions_trial SET revision_json = '{}' WHERE profile_key = ? AND revision_version = 1
    `).run(catalog.profile1.key)).toThrow('immutable');

    const batch = context.repository.claimAttempt({
      runId: frozen.id,
      expectedRunVersion: frozen.version,
      attemptId: ids.attempt1,
      normalizedRequestPayloadRef: ids.input1,
      costReservationMicros: 100,
      startedAt: t1
    });
    expect(batch.executionMode).toBe('batch');

    const fastRun = startRun(context.repository, {
      runId: ids.run2,
      sourceReceipt: ids.sourceReceipt2,
      classifiedInput: ids.input2
    });
    const fast = context.repository.claimAttempt({
      runId: fastRun.id,
      expectedRunVersion: fastRun.version,
      attemptId: ids.attempt2,
      normalizedRequestPayloadRef: ids.input2,
      requestedExecutionMode: 'fast',
      costReservationMicros: 100,
      startedAt: t1
    });
    expect(fast.executionMode).toBe('fast');
    expect(context.sqlite.query<{
      request_binding: string;
      request_binding_profile_key: string;
      request_binding_profile_version: number;
    }, [string]>(`
      SELECT request_binding, request_binding_profile_key, request_binding_profile_version
        FROM model_attempts_trial WHERE attempt_id = ?
    `).get(batch.attempt.id)).toEqual({
      request_binding: batch.requestBinding,
      request_binding_profile_key: bindingProfile.key,
      request_binding_profile_version: bindingProfile.version
    });
    expect(() => context.sqlite.query(`
      UPDATE model_attempts_trial SET request_binding = ? WHERE attempt_id = ?
    `).run(digest('9'), batch.attempt.id)).toThrow();

    context = restartTrial(context);
    expect(context.repository.getRun(ids.run1)).toMatchObject({
      profile: { version: 1, digest: catalog.profile1.digest },
      scaffold: { version: 1, digest: catalog.scaffold1.digest }
    });
    expect(context.repository.getAttempt(ids.attempt1)?.executionMode).toBe('batch');
    expect(context.repository.getAttempt(ids.attempt2)?.executionMode).toBe('fast');
    expect(context.repository.getProfile(catalog.profile2)).toEqual(catalog.profile2);
    expect(context.repository.getScaffold(catalog.scaffold2)).toEqual(catalog.scaffold2);

    const mismatched = new Database(context.path, { create: false, strict: true });
    opened.add(mismatched);
    mismatched.exec('PRAGMA foreign_keys = ON');
    expect(() => new ModelDurabilityTrialRepository(mismatched, {
      binding: {
        profile: { key: bindingProfile.key, version: bindingProfile.version + 1 },
        keyBytes: bindingKey
      }
    })).toThrow('model_binding_profile_mismatch');
    expect(() => new ModelDurabilityTrialRepository(mismatched, {
      binding: {
        profile: bindingProfile,
        keyBytes: Uint8Array.from(bindingKey, (byte) => byte ^ 0xff)
      }
    })).toThrow('model_binding_key_mismatch');
  });
});

describe('durable deterministic fake and classified bindings', () => {
  test('same run/attempt/request terminal-replays across restart and persists usage without raw content', async () => {
    let context = freshTrial();
    seedCatalog(context.repository);
    const run = startRun(context.repository, {
      runId: ids.run3,
      sourceReceipt: ids.sourceReceipt3,
      classifiedInput: ids.input3
    });
    const claimed = context.repository.claimAttempt({
      runId: run.id,
      expectedRunVersion: run.version,
      attemptId: ids.attempt3,
      normalizedRequestPayloadRef: ids.input3,
      costReservationMicros: 500,
      startedAt: t1
    });
    const rawRequestCanary = 'classified-request-canary-should-never-enter-sql';
    const rawOutputCanary = 'classified-output-canary-should-never-enter-sql';
    const request = requestFor(context.repository, claimed.run, claimed.attempt, rawRequestCanary);
    let scenarioExecutions = 0;
    const adapter = new DeterministicFakeAdapter(
      new SqliteDeterministicFakeTrialStore(context.sqlite),
      () => {
        scenarioExecutions += 1;
        return { kind: 'success', output: ids.result, inputTokens: 21, outputTokens: 8, costMicros: 345 };
      }
    );
    const first = await adapter.execute(request);
    expect(await adapter.execute(request)).toEqual(first);
    expect(scenarioExecutions).toBe(1);

    context = restartTrial(context);
    const restartedAdapter = new DeterministicFakeAdapter(
      new SqliteDeterministicFakeTrialStore(context.sqlite),
      () => {
        scenarioExecutions += 1;
        throw new Error('durable fake replay must not run the scenario');
      }
    );
    const replay = await restartedAdapter.execute(request);
    expect(replay).toEqual(first);
    expect(scenarioExecutions).toBe(1);
    const changedBinding = parseModelRequestBinding(`mrb1_${digest('f')}`);
    await expect(restartedAdapter.execute({
      ...request,
      requestBinding: changedBinding,
      providerIdempotencyKey: modelProviderIdempotencyKeyFor(changedBinding)
    }))
      .rejects.toThrow('attempt_request_conflict');

    if (replay.kind !== 'succeeded') throw new Error('unexpected fake observation');
    const reduced = reduceAttempt(context, {
      runId: claimed.run.id,
      attemptId: claimed.attempt.id,
      expectedRunVersion: claimed.run.version,
      expectedFence: claimed.attempt.fence,
      observation: replay,
      adoptedResultRef: ids.result,
      finishedAt: t2
    });
    expect(reduced.run).toMatchObject({
      state: 'succeeded',
      resultRef: ids.result,
      usage: {
        attemptsObserved: 1,
        reportedInputTokens: 21,
        reportedOutputTokens: 8,
        reportedCostMicros: 345
      }
    });
    expect(reduced.attempt.usage).toEqual({ inputTokens: 21, outputTokens: 8, costMicros: 345 });

    const rejecting = new DeterministicFakeAdapter(
      new SqliteDeterministicFakeTrialStore(context.sqlite),
      () => ({ kind: 'success', output: { raw: rawOutputCanary } })
    );
    await expect(rejecting.execute({
      ...request,
      runId: ids.run6,
      attemptId: ids.attempt6,
      requestBinding: parseModelRequestBinding(`mrb1_${digest('e')}`),
      providerIdempotencyKey: modelProviderIdempotencyKeyFor(parseModelRequestBinding(`mrb1_${digest('e')}`))
    })).rejects.toThrow('opaque PayloadRef');

    expectCanaryAbsent(context.sqlite, rawRequestCanary);
    expectCanaryAbsent(context.sqlite, rawOutputCanary);
    expect(() => context.sqlite.query(`
      UPDATE deterministic_fake_attempts_trial SET request_binding = ? WHERE attempt_id = ?
    `).run(digest('8'), claimed.attempt.id)).toThrow();
    context = restartTrial(context);
    expect(context.repository.getRun(run.id)).toMatchObject({
      state: 'succeeded',
      resultRef: ids.result,
      usage: { reportedCostMicros: 345 }
    });
    expect(context.repository.getAttempt(claimed.attempt.id)).toMatchObject({
      state: 'succeeded',
      usage: { inputTokens: 21, outputTokens: 8, costMicros: 345 }
    });
  });

  test('ambiguous acceptance survives restart and cannot become a retry before reconciliation', async () => {
    let context = freshTrial();
    seedCatalog(context.repository);
    const run = startRun(context.repository, {
      runId: ids.run4,
      sourceReceipt: ids.sourceReceipt4,
      classifiedInput: ids.input4
    });
    const claimed = context.repository.claimAttempt({
      runId: run.id,
      expectedRunVersion: run.version,
      attemptId: ids.attempt4,
      normalizedRequestPayloadRef: ids.input4,
      costReservationMicros: 500,
      startedAt: t1
    });
    const request = requestFor(context.repository, claimed.run, claimed.attempt, 'classified ambiguity probe');
    const adapter = new DeterministicFakeAdapter(
      new SqliteDeterministicFakeTrialStore(context.sqlite),
      () => ({ kind: 'acceptance_unknown', recovery: 'manual' })
    );
    const observation = await adapter.execute(request);
    if (observation.kind !== 'acceptance_unknown') throw new Error('unexpected fake observation');
    const ambiguous = reduceAttempt(context, {
      runId: claimed.run.id,
      attemptId: claimed.attempt.id,
      expectedRunVersion: claimed.run.version,
      expectedFence: claimed.attempt.fence,
      observation,
      finishedAt: t2
    });
    expect(ambiguous.run.state).toBe('reconciling');

    context = restartTrial(context);
    const restartedAdapter = new DeterministicFakeAdapter(
      new SqliteDeterministicFakeTrialStore(context.sqlite),
      () => { throw new Error('ambiguous attempt must be looked up, not resubmitted'); }
    );
    expect(await restartedAdapter.lookup(observation.evidence, request)).toEqual(observation);
    expect(() => context.repository.applyIntervention({
      runId: run.id,
      expectedRunVersion: ambiguous.run.version,
      disposition: 'safe_retry',
      evidenceId: 'recovery-evidence-1',
      retryAllowance: { maximumCostReservationMicros: 500, acceptsUnknownUsage: true },
      decidedAt: t3
    })).toThrow('requires_reconciliation');
    const reconciling = context.repository.applyIntervention({
      runId: run.id,
      expectedRunVersion: ambiguous.run.version,
      disposition: 'reconcile',
      evidenceId: 'recovery-evidence-1',
      decidedAt: t3
    });
    expect(reconciling.state).toBe('reconciling');
    expect(() => context.repository.claimAttempt({
      runId: run.id,
      expectedRunVersion: reconciling.version,
      attemptId: ids.attempt6,
      normalizedRequestPayloadRef: ids.input4,
      costReservationMicros: 100,
      startedAt: t3
    })).toThrow('model_run_not_claimable');
  });

  test('idempotent ambiguity rehydrates and reuses the original work binding across restart', () => {
    let context = freshTrial();
    seedCatalog(context.repository);
    const run = startRun(context.repository, {
      runId: ids.run4,
      sourceReceipt: ids.sourceReceipt4,
      classifiedInput: ids.input4
    });
    const first = context.repository.claimAttempt({
      runId: run.id,
      expectedRunVersion: run.version,
      attemptId: ids.attempt4,
      normalizedRequestPayloadRef: ids.input4,
      costReservationMicros: 500,
      startedAt: t1
    });
    const ambiguous = reduceAttempt(context, {
      runId: run.id,
      attemptId: first.attempt.id,
      expectedRunVersion: first.run.version,
      expectedFence: first.attempt.fence,
      observation: {
        kind: 'acceptance_unknown',
        recovery: 'idempotent_reuse',
        evidence: {
          adapter: first.attempt.adapter,
          providerRequestId: 'fake:ambiguous-idempotent-work',
          idempotencySupported: true,
          executionMode: first.executionMode
        }
      },
      finishedAt: t2
    });

    context = restartTrial(context);
    const approved = context.repository.applyIntervention({
      runId: run.id,
      expectedRunVersion: ambiguous.run.version,
      disposition: 'safe_retry',
      evidenceId: 'exact-idempotent-reuse-evidence',
      retryAllowance: { maximumCostReservationMicros: 500, acceptsUnknownUsage: true },
      decidedAt: t3
    });
    context = restartTrial(context);
    expect(() => context.repository.claimAttempt({
      runId: run.id,
      expectedRunVersion: approved.version,
      attemptId: ids.attempt6,
      normalizedRequestPayloadRef: ids.input6,
      costReservationMicros: 500,
      startedAt: t3
    })).toThrow('model_retry_request_binding_mismatch');
    expect(context.repository.getRun(run.id)).toMatchObject({ state: 'queued', version: approved.version });
    expect(context.repository.getAttempt(ids.attempt6)).toBeUndefined();

    const reused = context.repository.claimAttempt({
      runId: run.id,
      expectedRunVersion: approved.version,
      attemptId: ids.attempt6,
      normalizedRequestPayloadRef: ids.input4,
      costReservationMicros: 500,
      startedAt: t3
    });
    expect(reused.attempt).toMatchObject({
      id: ids.attempt6,
      number: 2,
      fence: 2,
      requestBinding: first.requestBinding
    });
    expect(reused.providerIdempotencyKey).toBe(first.providerIdempotencyKey);
    expect(reused.requestBinding).toBe(first.requestBinding);

    context = restartTrial(context);
    expect(context.repository.getAttempt(ids.attempt6)).toMatchObject({
      requestBinding: first.requestBinding,
      adapter: first.attempt.adapter
    });
  });

  test('never-retry failures and exhausted budgets remain closed after restart', () => {
    let context = freshTrial();
    seedCatalog(context.repository);
    const run = startRun(context.repository, {
      runId: ids.run4,
      sourceReceipt: ids.sourceReceipt4,
      classifiedInput: ids.input4
    });
    const claimed = context.repository.claimAttempt({
      runId: run.id,
      expectedRunVersion: run.version,
      attemptId: ids.attempt4,
      normalizedRequestPayloadRef: ids.input4,
      costReservationMicros: 500,
      startedAt: t1
    });
    const refused = reduceAttempt(context, {
      runId: run.id,
      attemptId: claimed.attempt.id,
      expectedRunVersion: claimed.run.version,
      expectedFence: claimed.attempt.fence,
      observation: {
        kind: 'known_failure',
        safeCode: 'provider_refusal',
        retryability: 'never',
        usage: { inputTokens: 1, outputTokens: 0, cachedInputTokens: 0, costMicros: 1 },
        evidence: { adapter: claimed.attempt.adapter, idempotencySupported: true }
      },
      finishedAt: t2
    });
    context = restartTrial(context);
    expect(context.repository.getRun(run.id)?.pendingIntervention).toMatchObject({
      reason: 'provider_failure',
      providerRetryability: 'never'
    });
    expect(() => context.repository.applyIntervention({
      runId: run.id,
      expectedRunVersion: refused.run.version,
      disposition: 'safe_retry',
      evidenceId: 'must-not-retry-refusal',
      retryAllowance: { maximumCostReservationMicros: 500, acceptsUnknownUsage: false },
      decidedAt: t3
    })).toThrow('model_provider_failure_not_retryable');

    const exhaustedRun = startRun(context.repository, {
      runId: ids.run5,
      sourceReceipt: ids.sourceReceipt5,
      classifiedInput: ids.input5
    });
    const exhaustedClaim = context.repository.claimAttempt({
      runId: exhaustedRun.id,
      expectedRunVersion: exhaustedRun.version,
      attemptId: ids.attempt5,
      normalizedRequestPayloadRef: ids.input5,
      costReservationMicros: 500,
      startedAt: t1
    });
    const exhausted = reduceAttempt(context, {
      runId: exhaustedRun.id,
      attemptId: exhaustedClaim.attempt.id,
      expectedRunVersion: exhaustedClaim.run.version,
      expectedFence: exhaustedClaim.attempt.fence,
      observation: {
        kind: 'known_failure',
        safeCode: 'provider_busy',
        retryability: 'policy',
        usage: { inputTokens: 10_001, outputTokens: 0, cachedInputTokens: 0, costMicros: 1 },
        evidence: { adapter: exhaustedClaim.attempt.adapter, idempotencySupported: true }
      },
      finishedAt: t2
    });
    context = restartTrial(context);
    expect(exhausted.run.state).toBe('exhausted');
    expect(() => context.repository.applyIntervention({
      runId: exhaustedRun.id,
      expectedRunVersion: exhausted.run.version,
      disposition: 'safe_retry',
      evidenceId: 'must-not-reopen-budget',
      retryAllowance: { maximumCostReservationMicros: 0, acceptsUnknownUsage: false },
      decidedAt: t3
    })).toThrow('model_budget_exhausted_cannot_retry');
  });

  test('invalid usage, adapter evidence, and completion time roll back without durable state', async () => {
    let context = freshTrial();
    seedCatalog(context.repository);
    const run = startRun(context.repository, {
      runId: ids.run4,
      sourceReceipt: ids.sourceReceipt4,
      classifiedInput: ids.input4
    });
    const claimed = context.repository.claimAttempt({
      runId: run.id,
      expectedRunVersion: run.version,
      attemptId: ids.attempt4,
      normalizedRequestPayloadRef: ids.input4,
      costReservationMicros: 500,
      startedAt: t1
    });
    const invalid = (observation: ModelAttemptObservation, finishedAt = t2) =>
      reduceAttempt(context, {
        runId: run.id,
        attemptId: claimed.attempt.id,
        expectedRunVersion: claimed.run.version,
        expectedFence: claimed.attempt.fence,
        observation,
        finishedAt
      });
    expect(() => invalid({
      kind: 'known_failure',
      safeCode: 'invalid_usage',
      retryability: 'never',
      usage: { costMicros: -1 }
    })).toThrow('non-negative safe integer');
    expect(() => invalid({
      kind: 'acceptance_unknown',
      recovery: 'lookup',
      evidence: { adapter: { key: 'wrong_adapter', version: 1 }, idempotencySupported: true }
    })).toThrow('model_observation_adapter_mismatch');
    expect(() => invalid({
      kind: 'known_failure',
      safeCode: 'backwards_time',
      retryability: 'policy'
    }, t0)).toThrow('cannot be before attempt start');
    expect(context.repository.getRun(run.id)).toMatchObject({ state: 'running', version: claimed.run.version });
    expect(context.repository.getAttempt(claimed.attempt.id)?.state).toBe('started');

    const fakeStore = new SqliteDeterministicFakeTrialStore(context.sqlite);
    expect(() => fakeStore.put(claimed.attempt.id, {
      requestBinding: claimed.requestBinding,
      observation: {
        kind: 'succeeded',
        output: ids.result,
        usage: { inputTokens: Number.NaN },
        evidence: { adapter: claimed.attempt.adapter, idempotencySupported: true }
      },
      cancelled: false
    })).toThrow('non-negative safe integer');
    expect(context.sqlite.query<{ count: number }, []>(`
      SELECT count(*) AS count FROM deterministic_fake_attempts_trial
    `).get()?.count).toBe(0);

    const adapter = new DeterministicFakeAdapter(fakeStore, () => ({
      kind: 'success', output: ids.result, inputTokens: 1
    }));
    await adapter.execute(requestFor(context.repository, claimed.run, claimed.attempt, 'valid usage fixture'));
    expect(() => context.sqlite.query(`
      UPDATE deterministic_fake_attempts_trial SET input_tokens = 1.5 WHERE attempt_id = ?
    `).run(claimed.attempt.id)).toThrow();

    context = restartTrial(context);
    expect(context.repository.getRun(run.id)).toMatchObject({ state: 'running', version: claimed.run.version });
    expect(context.repository.getAttempt(claimed.attempt.id)?.state).toBe('started');
  });
});

describe('durable model tool and cancellation fences', () => {
  test('sealed reduction freezes tool identity and rejects caller-supplied receipt or resume data', async () => {
    let context = freshTrial();
    seedCatalog(context.repository);
    const run = startRun(context.repository, {
      runId: ids.run5,
      sourceReceipt: ids.sourceReceipt5,
      classifiedInput: ids.input5
    });
    const claimed = context.repository.claimAttempt({
      runId: run.id,
      expectedRunVersion: run.version,
      attemptId: ids.attempt5,
      normalizedRequestPayloadRef: ids.input5,
      costReservationMicros: 500,
      startedAt: t1
    });
    const rawToolInputCanary = 'classified-tool-input-canary-never-persist';
    const tools: readonly ModelToolDefinition[] = [{
      operation: { name: 'foundation.read', version: 1 },
      description: 'Read a bounded foundation projection',
      inputJsonSchema: { type: 'object' }
    }];
    const request = requestFor(context.repository, claimed.run, claimed.attempt, rawToolInputCanary, tools);
    const adapter = new DeterministicFakeAdapter(
      new SqliteDeterministicFakeTrialStore(context.sqlite),
      () => ({
        kind: 'tool_requests',
        requests: [{
          callId: 'provider-tool-call-1',
          operation: { name: 'foundation.read', version: 1 },
          input: ids.toolInput
        }]
      })
    );
    const observation = await adapter.execute(request);
    if (observation.kind !== 'tool_requests') throw new Error('unexpected fake observation');
    const waiting = reduceAttempt(context, {
      runId: run.id,
      attemptId: claimed.attempt.id,
      expectedRunVersion: claimed.run.version,
      expectedFence: claimed.attempt.fence,
      observation,
      finishedAt: t2
    }, [{
      id: ids.tool1,
      sequence: 1,
      providerCallId: 'provider-tool-call-1',
      operation: { name: 'foundation.read', version: 1 },
      inputPayloadRef: ids.toolInput
    }]);
    expect(waiting.run.state).toBe('waiting_for_tool');

    context = restartTrial(context);
    const call = context.repository.getToolCall(ids.tool1);
    if (!call) throw new Error('sealed tool call missing');
    expect(call.operation).toEqual({ name: 'foundation.read', version: 1 });
    expect(call.inputBinding).toHaveLength(69);
    expect(call.inputBinding).toStartWith('mtb1_');
    expect(call.inputBinding).not.toBe(createHash('sha256').update(rawToolInputCanary).digest('hex'));
    expect(context.sqlite.query<{
      input_binding: string;
      input_binding_profile_key: string;
      input_binding_profile_version: number;
    }, [string]>(`
      SELECT input_binding, input_binding_profile_key, input_binding_profile_version
        FROM model_tool_calls_trial WHERE tool_call_id = ?
    `).get(call.id)).toEqual({
      input_binding: call.inputBinding,
      input_binding_profile_key: bindingProfile.key,
      input_binding_profile_version: bindingProfile.version
    });
    expect(() => context.sqlite.query(`
      UPDATE model_tool_calls_trial SET input_binding = ? WHERE tool_call_id = ?
    `).run(`mrb1_${digest('7')}`, call.id)).toThrow();
    expect(() => context.repository.attachToolReceipt(Object.freeze({})))
      .toThrow('unsealed_model_tool_receipt');
    expect(() => context.repository.resumeAfterTools(Object.freeze({})))
      .toThrow('unsealed_model_tool_resume');
    expectCanaryAbsent(context.sqlite, rawToolInputCanary);

    context = restartTrial(context);
    expect(context.repository.getToolCall(ids.tool1)).toMatchObject({
      operation: { name: 'foundation.read', version: 1 },
      inputRef: ids.toolInput
    });
    expect(context.repository.getRun(run.id)?.state).toBe('waiting_for_tool');
  });

  test('durable cancellation wins its version/fence and stale completion cannot overwrite it', async () => {
    let context = freshTrial();
    seedCatalog(context.repository);
    const run = startRun(context.repository, {
      runId: ids.run6,
      sourceReceipt: ids.sourceReceipt6,
      classifiedInput: ids.input6
    });
    const claimed = context.repository.claimAttempt({
      runId: run.id,
      expectedRunVersion: run.version,
      attemptId: ids.attempt6,
      normalizedRequestPayloadRef: ids.input6,
      costReservationMicros: 500,
      startedAt: t1
    });
    const request = requestFor(context.repository, claimed.run, claimed.attempt, 'classified cancellation probe');
    const adapter = new DeterministicFakeAdapter(
      new SqliteDeterministicFakeTrialStore(context.sqlite),
      () => ({ kind: 'acceptance_unknown', recovery: 'lookup' })
    );
    const accepted = await adapter.execute(request);
    if (accepted.kind !== 'acceptance_unknown') throw new Error('unexpected fake observation');

    expect(() => context.repository.requestCancellation({
      runId: run.id,
      expectedRunVersion: claimed.run.version,
      attemptId: claimed.attempt.id,
      expectedAttemptFence: claimed.attempt.fence + 1,
      requestedAt: t2
    })).toThrow('stale_model_attempt_fence');
    const cancelRequested = context.repository.requestCancellation({
      runId: run.id,
      expectedRunVersion: claimed.run.version,
      attemptId: claimed.attempt.id,
      expectedAttemptFence: claimed.attempt.fence,
      requestedAt: t2
    });
    expect(cancelRequested).toMatchObject({
      state: 'cancel_requested',
      activeAttempt: { id: claimed.attempt.id, fence: claimed.attempt.fence }
    });
    expect(() => reduceAttempt(context, {
      runId: run.id,
      attemptId: claimed.attempt.id,
      expectedRunVersion: claimed.run.version,
      expectedFence: claimed.attempt.fence,
      observation: accepted,
      finishedAt: t3
    })).toThrow('stale_model_run');
    expect(context.repository.getAttempt(claimed.attempt.id)?.state).toBe('started');

    expect(await adapter.cancel(accepted.evidence)).toEqual({ kind: 'cancelled' });
    const cancellationResult = context.repository.recordCancellationResult({
      runId: run.id,
      attemptId: claimed.attempt.id,
      expectedRunVersion: cancelRequested.version,
      expectedFence: claimed.attempt.fence,
      observation: { kind: 'cancelled' },
      observedAt: t3
    });
    expect(cancellationResult).toMatchObject({
      state: 'reconciling',
      lastCancellationResult: { outcome: 'cancelled', attemptId: claimed.attempt.id }
    });
    const cancelledObservation = await adapter.lookup(accepted.evidence, request);
    if (cancelledObservation.kind !== 'cancelled') throw new Error('expected durable cancellation');

    context = restartTrial(context);
    const restartedAdapter = new DeterministicFakeAdapter(
      new SqliteDeterministicFakeTrialStore(context.sqlite),
      () => { throw new Error('cancelled fake work must terminal-replay'); }
    );
    expect(await restartedAdapter.execute(request)).toEqual(cancelledObservation);
    expect(context.repository.getRun(run.id)).toMatchObject({
      state: 'reconciling',
      version: cancellationResult.version,
      lastCancellationResult: { outcome: 'cancelled' },
      activeAttempt: { fence: claimed.attempt.fence }
    });
    expect(context.repository.getAttempt(claimed.attempt.id)?.state).toBe('started');
    expect(() => reduceAttempt(context, {
      runId: run.id,
      attemptId: claimed.attempt.id,
      expectedRunVersion: cancellationResult.version,
      expectedFence: claimed.attempt.fence,
      observation: {
        kind: 'known_failure',
        safeCode: 'provider_terminal_after_cancel_request',
        retryability: 'never',
        evidence: { adapter: claimed.attempt.adapter, idempotencySupported: true }
      },
      finishedAt: t3
    })).toThrow('stale_model_attempt_fence');
    const terminal = context.repository.confirmCancellation({
      runId: run.id,
      attemptId: claimed.attempt.id,
      expectedRunVersion: cancellationResult.version,
      expectedFence: claimed.attempt.fence,
      observation: cancelledObservation,
      finishedAt: t3
    });
    expect(terminal.run).toMatchObject({ state: 'cancelled', reservedCostMicros: 0 });
    expect(terminal.run.activeAttempt).toBeUndefined();
    expect(terminal.attempt.state).toBe('cancelled');
    expect(() => context.repository.confirmCancellation({
      runId: run.id,
      attemptId: claimed.attempt.id,
      expectedRunVersion: terminal.run.version,
      expectedFence: claimed.attempt.fence,
      observation: cancelledObservation,
      finishedAt: t3
    })).toThrow('stale_model_attempt_fence');

    context = restartTrial(context);
    expect(context.repository.getRun(run.id)).toMatchObject({
      state: 'cancelled',
      version: terminal.run.version,
      reservedCostMicros: 0
    });
    expect(context.repository.getAttempt(claimed.attempt.id)?.state).toBe('cancelled');
  });

  test('too-late and runtime-invalid cancellation confirmations stay reconciling after restart', () => {
    let context = freshTrial();
    seedCatalog(context.repository);
    const run = startRun(context.repository, {
      runId: ids.run6,
      sourceReceipt: ids.sourceReceipt6,
      classifiedInput: ids.input6
    });
    const claimed = context.repository.claimAttempt({
      runId: run.id,
      expectedRunVersion: run.version,
      attemptId: ids.attempt6,
      normalizedRequestPayloadRef: ids.input6,
      costReservationMicros: 500,
      startedAt: t1
    });
    const requested = context.repository.requestCancellation({
      runId: run.id,
      expectedRunVersion: claimed.run.version,
      attemptId: claimed.attempt.id,
      expectedAttemptFence: claimed.attempt.fence,
      requestedAt: t2
    });
    const tooLate = context.repository.recordCancellationResult({
      runId: run.id,
      attemptId: claimed.attempt.id,
      expectedRunVersion: requested.version,
      expectedFence: claimed.attempt.fence,
      observation: { kind: 'too_late' },
      observedAt: t3
    });

    context = restartTrial(context);
    expect(() => context.repository.confirmCancellation({
      runId: run.id,
      attemptId: claimed.attempt.id,
      expectedRunVersion: tooLate.version,
      expectedFence: claimed.attempt.fence,
      observation: { kind: 'cancelled' },
      finishedAt: t3
    })).toThrow('model_cancellation_requires_reconciliation');
    expect(() => context.repository.confirmCancellation({
      runId: run.id,
      attemptId: claimed.attempt.id,
      expectedRunVersion: tooLate.version,
      expectedFence: claimed.attempt.fence,
      observation: { kind: 'too_late' } as never,
      finishedAt: t3
    })).toThrow('invalid_model_cancellation_confirmation');
    expect(context.repository.getRun(run.id)).toMatchObject({
      state: 'reconciling',
      version: tooLate.version,
      lastCancellationResult: { outcome: 'too_late' }
    });
    expect(context.repository.getAttempt(claimed.attempt.id)?.state).toBe('started');
  });
});
