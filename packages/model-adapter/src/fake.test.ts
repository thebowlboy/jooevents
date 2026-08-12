import { describe, expect, test } from 'bun:test';
import { parseAgentRunId, parseModelAttemptId } from '@jooevents/kernel';
import {
  DeterministicFakeAdapter,
  MemoryDeterministicFakeStore,
  modelProviderIdempotencyKeyFor,
  parseModelRequestBinding,
  resolveExecutionMode,
  validateAttemptRequest,
  type DeterministicFakeStore,
  type ModelAttemptRequest,
  type ModelProfileRevision
} from '.';

const digest = 'a'.repeat(64);
const runId = parseAgentRunId('01890f47-9abc-7def-8123-456789abc121');
const attemptId = parseModelAttemptId('01890f47-9abc-7def-8123-456789abc122');

function profile(overrides: Partial<ModelProfileRevision> = {}): ModelProfileRevision {
  return {
    key: 'foundation_fake',
    version: 1,
    digest,
    adapter: { key: 'deterministic_fake', version: 1 },
    modelId: 'deterministic-v1',
    controls: { maxOutputTokens: 1000, requireStructuredOutput: true },
    defaultExecutionMode: 'batch',
    budget: { maximumAttempts: 3, maxInputTokens: 10_000, maxOutputTokens: 2000, maxCostMicros: 1000, timeoutMs: 10_000 },
    capabilities: {
      structuredOutput: true,
      tools: true,
      batch: true,
      fast: true,
      lookup: true,
      cancellation: true,
      idempotency: true
    },
    ...overrides
  };
}

function request(overrides: Partial<ModelAttemptRequest> = {}): ModelAttemptRequest {
  return {
    runId,
    attemptId,
    requestBinding: parseModelRequestBinding(`mrb1_${digest}`),
    profile: profile(),
    scaffold: {
      key: 'foundation_contract_probe',
      version: 1,
      digest: 'b'.repeat(64),
      purpose: 'foundation_contract_probe',
      outputSchema: { key: 'probe_output', version: 1 },
      allowedTools: [{ name: 'probe.read', version: 1 }]
    },
    messages: [{ role: 'user', content: 'classified-at-runtime test input' }],
    tools: [],
    outputJsonSchema: { name: 'probe_output', schema: { type: 'object' }, strict: true },
    providerIdempotencyKey: modelProviderIdempotencyKeyFor(parseModelRequestBinding(`mrb1_${digest}`)),
    ...overrides
  };
}

type StoredFakeAttempt = Exclude<ReturnType<DeterministicFakeStore['get']>, undefined>;

class DetachedCopyFakeStore implements DeterministicFakeStore {
  readonly #attempts = new Map<string, StoredFakeAttempt>();

  get(attemptId: string): StoredFakeAttempt | undefined {
    const stored = this.#attempts.get(attemptId);
    return stored ? structuredClone(stored) : undefined;
  }

  put(attemptId: string, attempt: StoredFakeAttempt): void {
    this.#attempts.set(attemptId, structuredClone(attempt));
  }
}

describe('provider-neutral execution', () => {
  test('batch is the profile default and fast requires an explicit request', () => {
    expect(resolveExecutionMode(request())).toBe('batch');
    expect(resolveExecutionMode(request({ executionMode: 'fast' }))).toBe('fast');
  });

  test('unsupported required capabilities fail before provider work', () => {
    expect(() => validateAttemptRequest(request(), {
      ...profile().capabilities,
      lookup: false
    })).toThrow('Profile requires unsupported capability: lookup');
  });

  test('tool declarations cannot exceed the scaffold allowlist', async () => {
    const adapter = new DeterministicFakeAdapter(new MemoryDeterministicFakeStore(), () => ({ kind: 'success', output: {} }));
    await expect(adapter.execute(request({
      tools: [{ operation: { name: 'admin.commit', version: 1 }, description: 'forbidden', inputJsonSchema: {} }]
    }))).rejects.toThrow('Tool is not allowed by the scaffold');
  });

  test('the provider work key is derived from and cannot diverge from the frozen request binding', async () => {
    const adapter = new DeterministicFakeAdapter(new MemoryDeterministicFakeStore(), () => ({ kind: 'success', output: {} }));
    await expect(adapter.execute(request({
      providerIdempotencyKey: modelProviderIdempotencyKeyFor(
        parseModelRequestBinding(`mrb1_${'f'.repeat(64)}`)
      )
    }))).rejects.toThrow('model_provider_idempotency_key_mismatch');
  });
});

describe('deterministic durable fake', () => {
  test('same attempt and request replays exactly without running the scenario twice', async () => {
    let executions = 0;
    const adapter = new DeterministicFakeAdapter(new MemoryDeterministicFakeStore(), () => {
      executions += 1;
      return { kind: 'success', output: { title: 'Event' }, inputTokens: 10, outputTokens: 4, costMicros: 25 };
    });
    const first = await adapter.execute(request());
    const replay = await adapter.execute(request());
    expect(replay).toEqual(first);
    expect(executions).toBe(1);
    expect(first.kind === 'succeeded' ? first.usage : {}).toEqual({ inputTokens: 10, outputTokens: 4, costMicros: 25 });
  });

  test('same attempt with a changed request binding refuses instead of repeating work', async () => {
    const adapter = new DeterministicFakeAdapter(new MemoryDeterministicFakeStore(), () => ({ kind: 'acceptance_unknown', recovery: 'lookup' }));
    await adapter.execute(request());
    const changedBinding = parseModelRequestBinding(`mrb1_${'c'.repeat(64)}`);
    await expect(adapter.execute(request({
      requestBinding: changedBinding,
      providerIdempotencyKey: modelProviderIdempotencyKeyFor(changedBinding)
    }))).rejects.toThrow('attempt_request_conflict');
  });

  test('invalid scenario usage fails before the durable fake stores an observation', async () => {
    const store = new MemoryDeterministicFakeStore();
    const adapter = new DeterministicFakeAdapter(store, () => ({
      kind: 'success',
      output: { title: 'Event' },
      inputTokens: -1
    }));
    await expect(adapter.execute(request())).rejects.toThrow('usage.inputTokens must be a non-negative safe integer');
    expect(store.get(attemptId)).toBeUndefined();
  });

  test('lookup and cancellation use only safe provider evidence', async () => {
    const adapter = new DeterministicFakeAdapter(new MemoryDeterministicFakeStore(), () => ({ kind: 'acceptance_unknown', recovery: 'lookup' }));
    const observation = await adapter.execute(request());
    expect(observation.kind).toBe('acceptance_unknown');
    if (observation.kind !== 'acceptance_unknown') throw new Error('unexpected fixture');
    expect(await adapter.lookup(observation.evidence, request())).toEqual(observation);
    expect(await adapter.cancel(observation.evidence)).toEqual({ kind: 'cancelled' });
    expect(await adapter.lookup(observation.evidence, request())).toEqual({ kind: 'cancelled', evidence: observation.evidence });
  });

  test('cancellation is written back when the durable store returns detached records', async () => {
    const store = new DetachedCopyFakeStore();
    const adapter = new DeterministicFakeAdapter(store, () => ({ kind: 'acceptance_unknown', recovery: 'lookup' }));
    const observation = await adapter.execute(request());
    if (observation.kind !== 'acceptance_unknown') throw new Error('unexpected fixture');

    expect(await adapter.cancel(observation.evidence)).toEqual({ kind: 'cancelled' });

    const restarted = new DeterministicFakeAdapter(store, () => {
      throw new Error('a cancelled attempt must replay without executing again');
    });
    expect(await restarted.lookup(observation.evidence, request())).toEqual({
      kind: 'cancelled',
      evidence: observation.evidence
    });
  });
});
