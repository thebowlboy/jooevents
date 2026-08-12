import type {
  ModelAttemptObservation,
  ModelAttemptRequest,
  ModelCancelObservation,
  ModelLookupObservation,
  ModelProviderAdapter,
  ProviderCapabilities,
  SafeProviderEvidence,
  ModelDefinitionRef
} from './types';
import {
  resolveExecutionMode,
  validateAttemptRequest,
  validateModelAttemptObservationUsage
} from './validation';

export type DeterministicFakeScenario =
  | { readonly kind: 'success'; readonly output: unknown; readonly inputTokens?: number; readonly outputTokens?: number; readonly costMicros?: number }
  | { readonly kind: 'tool_requests'; readonly requests: Extract<ModelAttemptObservation, { kind: 'tool_requests' }>['requests'] }
  | { readonly kind: 'schema_invalid'; readonly rawOutputRef: import('@jooevents/kernel').PayloadRef }
  | { readonly kind: 'known_failure'; readonly safeCode: string; readonly retryability: 'never' | 'policy' }
  | { readonly kind: 'acceptance_unknown'; readonly recovery: 'lookup' | 'idempotent_reuse' | 'manual' }
  | { readonly kind: 'cancelled' };

interface StoredAttempt {
  readonly requestBinding: import('./bindings').ModelRequestBinding;
  observation: ModelAttemptObservation;
  cancelled: boolean;
}

export interface DeterministicFakeStore {
  get(attemptId: string): StoredAttempt | undefined;
  put(attemptId: string, attempt: StoredAttempt): void;
}

export class MemoryDeterministicFakeStore implements DeterministicFakeStore {
  readonly #attempts = new Map<string, StoredAttempt>();

  get(attemptId: string): StoredAttempt | undefined {
    return this.#attempts.get(attemptId);
  }

  put(attemptId: string, attempt: StoredAttempt): void {
    this.#attempts.set(attemptId, attempt);
  }
}

const capabilities: ProviderCapabilities = {
  structuredOutput: true,
  tools: true,
  batch: true,
  fast: true,
  lookup: true,
  cancellation: true,
  idempotency: true
};

export class DeterministicFakeAdapter implements ModelProviderAdapter {
  readonly ref: ModelDefinitionRef = { key: 'deterministic_fake', version: 1 };

  constructor(
    private readonly store: DeterministicFakeStore,
    private readonly scenarioFor: (request: ModelAttemptRequest) => DeterministicFakeScenario
  ) {}

  describeCapabilities(): ProviderCapabilities {
    return capabilities;
  }

  async execute(request: ModelAttemptRequest): Promise<ModelAttemptObservation> {
    validateAttemptRequest(request, capabilities);
    if (request.profile.adapter.key !== this.ref.key || request.profile.adapter.version !== this.ref.version) {
      throw new TypeError('Profile adapter does not match deterministic fake');
    }
    resolveExecutionMode(request);
    const existing = this.store.get(request.attemptId);
    if (existing) {
      if (existing.requestBinding !== request.requestBinding) throw new TypeError('attempt_request_conflict');
      return existing.observation;
    }

    const evidence: SafeProviderEvidence = {
      adapter: this.ref,
      providerRequestId: `fake:${request.attemptId}`,
      idempotencySupported: true,
      executionMode: resolveExecutionMode(request)
    };
    const scenario = this.scenarioFor(request);
    const observation = toObservation(scenario, evidence);
    validateModelAttemptObservationUsage(observation);
    this.store.put(request.attemptId, { requestBinding: request.requestBinding, observation, cancelled: false });
    return observation;
  }

  async lookup(evidence: SafeProviderEvidence, _frozenRequest: ModelAttemptRequest): Promise<ModelLookupObservation> {
    if (evidence.adapter.key !== this.ref.key || evidence.adapter.version !== this.ref.version) return { kind: 'not_found' };
    const prefix = 'fake:';
    if (!evidence.providerRequestId?.startsWith(prefix)) return { kind: 'not_found' };
    const stored = this.store.get(evidence.providerRequestId.slice(prefix.length));
    return stored?.observation ?? { kind: 'not_found' };
  }

  async cancel(evidence: SafeProviderEvidence): Promise<ModelCancelObservation> {
    if (evidence.adapter.key !== this.ref.key || evidence.adapter.version !== this.ref.version) return { kind: 'unknown' };
    const prefix = 'fake:';
    if (!evidence.providerRequestId?.startsWith(prefix)) return { kind: 'unknown' };
    const attemptId = evidence.providerRequestId.slice(prefix.length);
    const stored = this.store.get(attemptId);
    if (!stored) return { kind: 'unknown' };
    if (stored.observation.kind === 'succeeded' || stored.observation.kind === 'known_failure' || stored.observation.kind === 'schema_invalid') {
      return { kind: 'too_late' };
    }
    stored.cancelled = true;
    stored.observation = { kind: 'cancelled', evidence };
    this.store.put(attemptId, stored);
    return { kind: 'cancelled' };
  }
}

function toObservation(scenario: DeterministicFakeScenario, evidence: SafeProviderEvidence): ModelAttemptObservation {
  switch (scenario.kind) {
    case 'success':
      return {
        kind: 'succeeded',
        output: scenario.output,
        usage: {
          ...(scenario.inputTokens === undefined ? {} : { inputTokens: scenario.inputTokens }),
          ...(scenario.outputTokens === undefined ? {} : { outputTokens: scenario.outputTokens }),
          ...(scenario.costMicros === undefined ? {} : { costMicros: scenario.costMicros })
        },
        evidence
      };
    case 'tool_requests':
      return { kind: 'tool_requests', requests: scenario.requests, usage: {}, evidence };
    case 'schema_invalid':
      return { kind: 'schema_invalid', rawOutputRef: scenario.rawOutputRef, usage: {}, safeCode: 'model_output_schema_invalid', evidence };
    case 'known_failure':
      return { kind: 'known_failure', safeCode: scenario.safeCode, retryability: scenario.retryability, evidence };
    case 'acceptance_unknown':
      return { kind: 'acceptance_unknown', evidence, recovery: scenario.recovery };
    case 'cancelled':
      return { kind: 'cancelled', evidence };
  }
}
