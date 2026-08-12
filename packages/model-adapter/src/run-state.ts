import {
  createPayloadRef,
  parseAggregateVersion,
  parsePayloadRefId,
  type AgentRunId,
  type AuthorityCitationId,
  type ModelAttemptId,
  type ModelToolCallId,
  type OperationReceiptId,
  type PayloadRef,
  type UtcInstant
} from '@jooevents/kernel';
import type {
  ModelAttemptObservation,
  ModelAttemptRecord,
  ModelBudget,
  ModelCancelObservation,
  ModelDefinitionRef,
  ModelExecutionMode,
  ModelRunRecord,
  ModelScaffoldRevision,
  ModelToolCallRecord,
  ModelUsageLedger,
  NormalizedUsage
} from './types';
import {
  parseModelRequestBinding,
  parseModelToolInputBinding,
  type ModelRequestBinding,
  type ModelToolInputBinding
} from './bindings';
import { validateNormalizedUsage } from './validation';

const digestPattern = /^[a-f0-9]{64}$/;

export interface CreateModelRunInput {
  readonly id: AgentRunId;
  readonly profile: ModelDefinitionRef & { readonly digest: string; readonly adapter: ModelDefinitionRef };
  readonly scaffold: ModelScaffoldRevision;
  readonly sourceOperation: { readonly name: string; readonly version: number; readonly receiptId: OperationReceiptId };
  readonly scopeKey: string;
  readonly authorityCitationId: AuthorityCitationId;
  readonly classifiedInputRefs: readonly PayloadRef[];
  readonly createdAt: UtcInstant;
  readonly budget: ModelBudget;
}

export interface ClaimModelAttemptInput {
  readonly expectedRunVersion: number;
  readonly attemptId: ModelAttemptId;
  readonly requestBinding: ModelRequestBinding;
  readonly executionMode: ModelExecutionMode;
  readonly costReservationMicros: number;
  readonly startedAt: UtcInstant;
}

export interface ReduceModelAttemptInput {
  readonly expectedRunVersion: number;
  readonly observation: ModelAttemptObservation;
  readonly finishedAt: UtcInstant;
  readonly adoptedResultRef?: PayloadRef;
}

export type ModelContinuationDisposition =
  | 'safe_retry'
  | 'reconcile'
  | 'pause_for_renewed_approval'
  | 'replan'
  | 'compensate'
  | 'block'
  | 'attention';

export interface ApplyModelInterventionInput {
  readonly expectedRunVersion: number;
  readonly disposition: ModelContinuationDisposition;
  readonly evidenceId: string;
  readonly retryAllowance?: {
    readonly maximumCostReservationMicros: number;
    readonly acceptsUnknownUsage: boolean;
  };
  readonly decidedAt: UtcInstant;
}

export interface ModelAttemptReduction {
  readonly run: ModelRunRecord;
  readonly attempt: ModelAttemptRecord;
}

export interface RequestModelCancellationInput {
  readonly expectedRunVersion: number;
  readonly expectedActiveAttempt: {
    readonly id: ModelAttemptId;
    readonly fence: number;
  };
  readonly requestedAt: UtcInstant;
}

export interface ConfirmModelCancellationInput {
  readonly expectedRunVersion: number;
  readonly expectedAttemptId: ModelAttemptId;
  readonly expectedFence: number;
  readonly observation: Extract<ModelAttemptObservation, { readonly kind: 'cancelled' }>;
  readonly finishedAt: UtcInstant;
}

export interface RecordModelCancellationResultInput {
  readonly expectedRunVersion: number;
  readonly expectedAttemptId: ModelAttemptId;
  readonly expectedFence: number;
  readonly observation: ModelCancelObservation;
  readonly observedAt: UtcInstant;
}

function assertPositive(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive safe integer`);
}

function assertNonNegative(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative safe integer`);
}

function safeAdd(left: number, right: number, label: string): number {
  assertNonNegative(left, `${label}.current`);
  assertNonNegative(right, `${label}.increment`);
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) throw new TypeError(`${label} overflow`);
  return sum;
}

function assertUsageLedger(ledger: ModelUsageLedger): void {
  assertNonNegative(ledger.attemptsObserved, 'usageLedger.attemptsObserved');
  assertNonNegative(ledger.reportedInputTokens, 'usageLedger.reportedInputTokens');
  assertNonNegative(ledger.reportedOutputTokens, 'usageLedger.reportedOutputTokens');
  assertNonNegative(ledger.reportedCachedInputTokens, 'usageLedger.reportedCachedInputTokens');
  assertNonNegative(ledger.reportedCostMicros, 'usageLedger.reportedCostMicros');
}

function assertRetryBudgetAvailable(run: ModelRunRecord): void {
  assertUsageLedger(run.usage);
  if (run.attemptsStarted >= run.budget.maximumAttempts) throw new TypeError('model_attempt_budget_exhausted');
  if (
    run.usage.reportedInputTokens >= run.budget.maxInputTokens ||
    run.usage.reportedOutputTokens >= run.budget.maxOutputTokens ||
    run.usage.reportedCostMicros >= run.budget.maxCostMicros
  ) {
    throw new TypeError('model_usage_budget_exhausted');
  }
}

function nextVersion(run: ModelRunRecord): ReturnType<typeof parseAggregateVersion> {
  return parseAggregateVersion(run.version + 1);
}

function assertExpectedVersion(run: ModelRunRecord, expected: number): void {
  if (run.version !== expected) throw new TypeError('stale_model_run');
}

function assertInstantNotBefore(value: UtcInstant, minimum: UtcInstant, label: string): void {
  const valueMs = Date.parse(value);
  const minimumMs = Date.parse(minimum);
  if (!Number.isSafeInteger(valueMs) || !Number.isSafeInteger(minimumMs) || valueMs < minimumMs) {
    throw new TypeError(`${label} cannot be before attempt start`);
  }
}

function assertAdapterRef(reference: ModelDefinitionRef, label: string): void {
  if (!reference || typeof reference !== 'object' || !reference.key) {
    throw new TypeError(`${label}.key is required`);
  }
  assertPositive(reference.version, `${label}.version`);
}

function freeze<Value>(value: Value): Value {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  }
  return value;
}

function emptyUsage(): ModelUsageLedger {
  return freeze({
    attemptsObserved: 0,
    reportedInputTokens: 0,
    reportedOutputTokens: 0,
    reportedCachedInputTokens: 0,
    reportedCostMicros: 0,
    missing: []
  });
}

export function createModelRun(input: CreateModelRunInput): ModelRunRecord {
  if (!digestPattern.test(input.profile.digest) || !digestPattern.test(input.scaffold.digest)) {
    throw new TypeError('Model run profile and scaffold digests must be lowercase SHA-256');
  }
  if (!input.scopeKey || !input.sourceOperation.name) throw new TypeError('Model run source and scope are required');
  assertPositive(input.profile.version, 'profile.version');
  assertAdapterRef(input.profile.adapter, 'profile.adapter');
  assertPositive(input.scaffold.version, 'scaffold.version');
  assertPositive(input.sourceOperation.version, 'sourceOperation.version');
  assertPositive(input.budget.maximumAttempts, 'budget.maximumAttempts');
  assertPositive(input.budget.maxInputTokens, 'budget.maxInputTokens');
  assertPositive(input.budget.maxOutputTokens, 'budget.maxOutputTokens');
  assertNonNegative(input.budget.maxCostMicros, 'budget.maxCostMicros');
  assertPositive(input.budget.timeoutMs, 'budget.timeoutMs');

  return freeze({
    id: input.id,
    version: parseAggregateVersion(1),
    state: 'queued',
    profile: { key: input.profile.key, version: input.profile.version, digest: input.profile.digest },
    profileAdapter: { ...input.profile.adapter },
    scaffold: { key: input.scaffold.key, version: input.scaffold.version, digest: input.scaffold.digest },
    sourceOperation: { ...input.sourceOperation },
    scopeKey: input.scopeKey,
    authorityCitationId: input.authorityCitationId,
    classifiedInputRefs: input.classifiedInputRefs.map((reference) => ({ ...reference })),
    requestedOutputSchema: { ...input.scaffold.outputSchema },
    budget: { ...input.budget },
    usage: emptyUsage(),
    attemptsStarted: 0,
    reservedCostMicros: 0,
    createdAt: input.createdAt,
    updatedAt: input.createdAt
  });
}

export function claimModelAttempt(
  run: ModelRunRecord,
  input: ClaimModelAttemptInput
): { readonly run: ModelRunRecord; readonly attempt: ModelAttemptRecord } {
  assertExpectedVersion(run, input.expectedRunVersion);
  if (run.state !== 'queued' || run.activeAttempt) throw new TypeError('model_run_not_claimable');
  assertRetryBudgetAvailable(run);
  parseModelRequestBinding(input.requestBinding);
  assertAdapterRef(run.profileAdapter, 'run.profileAdapter');
  if (
    run.retryAllowance?.requiredRequestBinding !== undefined &&
    input.requestBinding !== run.retryAllowance.requiredRequestBinding
  ) {
    throw new TypeError('model_retry_request_binding_mismatch');
  }
  assertNonNegative(input.costReservationMicros, 'costReservationMicros');
  if (run.usage.missing.includes('costMicros') && run.retryAllowance?.acceptsUnknownUsage !== true) {
    throw new TypeError('model_usage_unknown_requires_intervention');
  }
  if (run.retryAllowance && input.costReservationMicros > run.retryAllowance.maximumCostReservationMicros) {
    throw new TypeError('model_retry_allowance_exceeded');
  }
  if (safeAdd(run.usage.reportedCostMicros, input.costReservationMicros, 'model cost reservation') > run.budget.maxCostMicros) {
    throw new TypeError('model_cost_budget_exhausted');
  }

  const number = run.attemptsStarted + 1;
  const fence = number;
  const attempt = freeze({
    id: input.attemptId,
    runId: run.id,
    number,
    fence,
    requestBinding: input.requestBinding,
    adapter: { ...run.profileAdapter },
    costReservationMicros: input.costReservationMicros,
    executionMode: input.executionMode,
    state: 'started' as const,
    startedAt: input.startedAt
  });
  const { retryAllowance: _retryAllowance, ...claimableRun } = run;
  const claimed = freeze({
    ...claimableRun,
    version: nextVersion(run),
    state: 'running' as const,
    attemptsStarted: number,
    reservedCostMicros: input.costReservationMicros,
    activeAttempt: { id: input.attemptId, fence },
    updatedAt: input.startedAt
  });
  return { run: claimed, attempt };
}

function observationUsage(observation: ModelAttemptObservation): NormalizedUsage | undefined {
  switch (observation.kind) {
    case 'succeeded':
    case 'tool_requests':
    case 'schema_invalid':
      return observation.usage;
    case 'known_failure':
    case 'cancelled':
      return observation.usage;
    case 'acceptance_unknown':
      return undefined;
  }
}

function appendUsage(ledger: ModelUsageLedger, usage: NormalizedUsage | undefined): ModelUsageLedger {
  assertUsageLedger(ledger);
  if (usage !== undefined) validateNormalizedUsage(usage);
  const missing = new Set(ledger.missing);
  const fields = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'costMicros'] as const;
  for (const field of fields) if (usage?.[field] === undefined) missing.add(field);
  return freeze({
    attemptsObserved: safeAdd(ledger.attemptsObserved, 1, 'model usage attempts'),
    reportedInputTokens: safeAdd(ledger.reportedInputTokens, usage?.inputTokens ?? 0, 'model input-token ledger'),
    reportedOutputTokens: safeAdd(ledger.reportedOutputTokens, usage?.outputTokens ?? 0, 'model output-token ledger'),
    reportedCachedInputTokens: safeAdd(ledger.reportedCachedInputTokens, usage?.cachedInputTokens ?? 0, 'model cached-input-token ledger'),
    reportedCostMicros: safeAdd(ledger.reportedCostMicros, usage?.costMicros ?? 0, 'model cost ledger'),
    missing: [...missing].sort()
  });
}

function attemptState(observation: ModelAttemptObservation): ModelAttemptRecord['state'] {
  return observation.kind;
}

export function reduceModelAttempt(
  run: ModelRunRecord,
  attempt: ModelAttemptRecord,
  input: ReduceModelAttemptInput
): ModelAttemptReduction {
  assertExpectedVersion(run, input.expectedRunVersion);
  const cancellationResult = run.lastCancellationResult;
  const cancellationReconciliation =
    run.state === 'reconciling' &&
    (cancellationResult?.outcome === 'too_late' || cancellationResult?.outcome === 'unknown') &&
    cancellationResult.attemptId === attempt.id &&
    cancellationResult.fence === attempt.fence;
  if (
    (run.state !== 'running' && !cancellationReconciliation) ||
    attempt.state !== 'started' || attempt.runId !== run.id ||
    run.activeAttempt?.id !== attempt.id || run.activeAttempt.fence !== attempt.fence
  ) {
    throw new TypeError('stale_model_attempt_fence');
  }
  if (input.observation.kind === 'succeeded' && !input.adoptedResultRef) {
    throw new TypeError('successful_model_output_requires_adopted_payload');
  }
  if (input.observation.kind !== 'succeeded' && input.adoptedResultRef) {
    throw new TypeError('only_successful_model_output_accepts_result_payload');
  }
  assertInstantNotBefore(input.finishedAt, attempt.startedAt, 'finishedAt');
  if (
    'evidence' in input.observation && input.observation.evidence &&
    (
      input.observation.evidence.adapter.key !== attempt.adapter.key ||
      input.observation.evidence.adapter.version !== attempt.adapter.version
    )
  ) {
    throw new TypeError('model_observation_adapter_mismatch');
  }
  if (
    input.observation.kind === 'acceptance_unknown' &&
    input.observation.recovery === 'idempotent_reuse' &&
    input.observation.evidence.idempotencySupported !== true
  ) {
    throw new TypeError('model_idempotent_reuse_not_supported');
  }

  const usage = observationUsage(input.observation);
  const ledger = appendUsage(run.usage, usage);
  const budgetExceeded =
    ledger.reportedInputTokens > run.budget.maxInputTokens ||
    ledger.reportedOutputTokens > run.budget.maxOutputTokens ||
    ledger.reportedCostMicros > run.budget.maxCostMicros;

  let state: ModelRunRecord['state'];
  let safeFailureCode: string | undefined;
  let pendingIntervention: ModelRunRecord['pendingIntervention'] | undefined;
  let resultRef: PayloadRef | undefined;
  if (budgetExceeded) {
    state = 'exhausted';
    safeFailureCode = 'model_budget_exceeded';
    pendingIntervention = { sourceAttemptId: attempt.id, reason: 'budget_exhausted' };
  } else {
    switch (input.observation.kind) {
      case 'succeeded':
        state = 'succeeded';
        resultRef = input.adoptedResultRef;
        break;
      case 'tool_requests':
        state = 'waiting_for_tool';
        break;
      case 'schema_invalid':
        state = 'attention';
        safeFailureCode = input.observation.safeCode;
        pendingIntervention = { sourceAttemptId: attempt.id, reason: 'schema_invalid' };
        break;
      case 'known_failure':
        state = 'attention';
        safeFailureCode = input.observation.safeCode;
        pendingIntervention = {
          sourceAttemptId: attempt.id,
          reason: 'provider_failure',
          providerRetryability: input.observation.retryability
        };
        break;
      case 'acceptance_unknown':
        state = 'reconciling';
        safeFailureCode = 'model_acceptance_unknown';
        pendingIntervention = {
          sourceAttemptId: attempt.id,
          reason: 'acceptance_unknown',
          providerRecovery: input.observation.recovery,
          providerIdempotencySupported: input.observation.evidence.idempotencySupported,
          ...(input.observation.recovery === 'idempotent_reuse'
            ? { requiredRetryRequestBinding: attempt.requestBinding }
            : {})
        };
        break;
      case 'cancelled':
        state = 'cancelled';
        break;
    }
  }

  const finishedAttempt = freeze({
    ...attempt,
    state: attemptState(input.observation),
    ...(input.observation.kind === 'tool_requests' ? {
      requestedTools: input.observation.requests.map((request) => ({
        providerCallId: request.callId,
        operation: { ...request.operation }
      }))
    } : {}),
    ...(usage === undefined ? {} : { usage: { ...usage } }),
    ...('evidence' in input.observation && input.observation.evidence ? { evidence: { ...input.observation.evidence } } : {}),
    finishedAt: input.finishedAt
  });
  const {
    activeAttempt: _activeAttempt,
    pendingIntervention: _pendingIntervention,
    safeFailureCode: _safeFailureCode,
    resultRef: _resultRef,
    lastCancellationResult: _lastCancellationResult,
    ...runBase
  } = run;
  const reduced = freeze({
    ...runBase,
    version: nextVersion(run),
    state,
    usage: ledger,
    reservedCostMicros: 0,
    ...(resultRef ? { resultRef } : {}),
    ...(safeFailureCode ? { safeFailureCode } : {}),
    ...(pendingIntervention ? { pendingIntervention } : {}),
    updatedAt: input.finishedAt
  });
  return { run: reduced, attempt: finishedAttempt };
}

export function requestModelCancellation(
  run: ModelRunRecord,
  input: RequestModelCancellationInput
): ModelRunRecord {
  assertExpectedVersion(run, input.expectedRunVersion);
  if (
    run.state !== 'running' || !run.activeAttempt ||
    run.activeAttempt.id !== input.expectedActiveAttempt.id ||
    run.activeAttempt.fence !== input.expectedActiveAttempt.fence
  ) {
    throw new TypeError('stale_model_attempt_fence');
  }
  const { lastCancellationResult: _lastCancellationResult, safeFailureCode: _safeFailureCode, ...runBase } = run;
  return freeze({
    ...runBase,
    version: nextVersion(run),
    state: 'cancel_requested' as const,
    updatedAt: input.requestedAt
  });
}

export function recordModelCancellationResult(
  run: ModelRunRecord,
  attempt: ModelAttemptRecord,
  input: RecordModelCancellationResultInput
): ModelRunRecord {
  assertExpectedVersion(run, input.expectedRunVersion);
  if (
    run.state !== 'cancel_requested' || attempt.state !== 'started' || attempt.runId !== run.id ||
    attempt.id !== input.expectedAttemptId || attempt.fence !== input.expectedFence ||
    run.activeAttempt?.id !== input.expectedAttemptId || run.activeAttempt.fence !== input.expectedFence
  ) {
    throw new TypeError('stale_model_attempt_fence');
  }
  const cancellationOutcome = input.observation?.kind;
  if (
    cancellationOutcome !== 'cancelled' && cancellationOutcome !== 'too_late' &&
    cancellationOutcome !== 'unknown' && cancellationOutcome !== 'unsupported'
  ) {
    throw new TypeError('invalid_model_cancellation_result');
  }
  assertInstantNotBefore(input.observedAt, attempt.startedAt, 'observedAt');
  if (Date.parse(input.observedAt) < Date.parse(run.updatedAt)) {
    throw new TypeError('observedAt cannot be before cancellation request');
  }

  const state: ModelRunRecord['state'] = cancellationOutcome === 'unsupported' ? 'running' : 'reconciling';
  const safeFailureCode = cancellationOutcome === 'unsupported'
    ? 'model_cancellation_unsupported_continuing'
    : cancellationOutcome === 'too_late'
      ? 'model_cancellation_too_late_reconcile'
      : cancellationOutcome === 'unknown'
        ? 'model_cancellation_unknown_reconcile'
        : undefined;
  const { lastCancellationResult: _lastCancellationResult, safeFailureCode: _safeFailureCode, ...runBase } = run;
  return freeze({
    ...runBase,
    version: nextVersion(run),
    state,
    lastCancellationResult: {
      attemptId: attempt.id,
      fence: attempt.fence,
      outcome: cancellationOutcome,
      observedAt: input.observedAt
    },
    ...(safeFailureCode === undefined ? {} : { safeFailureCode }),
    updatedAt: input.observedAt
  });
}

export function confirmModelCancellation(
  run: ModelRunRecord,
  attempt: ModelAttemptRecord,
  input: ConfirmModelCancellationInput
): ModelAttemptReduction {
  assertExpectedVersion(run, input.expectedRunVersion);
  if (
    (run.state !== 'cancel_requested' && run.state !== 'reconciling') ||
    attempt.state !== 'started' || attempt.runId !== run.id ||
    attempt.id !== input.expectedAttemptId || attempt.fence !== input.expectedFence ||
    run.activeAttempt?.id !== input.expectedAttemptId || run.activeAttempt.fence !== input.expectedFence
  ) {
    throw new TypeError('stale_model_attempt_fence');
  }
  if (!input.observation || input.observation.kind !== 'cancelled') {
    throw new TypeError('invalid_model_cancellation_confirmation');
  }
  if (run.state === 'reconciling' && run.lastCancellationResult?.outcome !== 'cancelled') {
    throw new TypeError('model_cancellation_requires_reconciliation');
  }
  assertInstantNotBefore(input.finishedAt, attempt.startedAt, 'finishedAt');
  if (
    input.observation.evidence &&
    (
      input.observation.evidence.adapter.key !== attempt.adapter.key ||
      input.observation.evidence.adapter.version !== attempt.adapter.version
    )
  ) {
    throw new TypeError('model_observation_adapter_mismatch');
  }

  const usage = observationUsage(input.observation);
  const ledger = appendUsage(run.usage, usage);
  const finishedAttempt = freeze({
    ...attempt,
    state: 'cancelled' as const,
    ...(usage === undefined ? {} : { usage: { ...usage } }),
    ...(input.observation.evidence ? { evidence: { ...input.observation.evidence } } : {}),
    finishedAt: input.finishedAt
  });
  const {
    activeAttempt: _activeAttempt,
    pendingIntervention: _pendingIntervention,
    safeFailureCode: _safeFailureCode,
    resultRef: _resultRef,
    lastCancellationResult: _lastCancellationResult,
    ...runBase
  } = run;
  const cancelled = freeze({
    ...runBase,
    version: nextVersion(run),
    state: 'cancelled' as const,
    usage: ledger,
    reservedCostMicros: 0,
    updatedAt: input.finishedAt
  });
  return { run: cancelled, attempt: finishedAttempt };
}

export function applyModelIntervention(
  run: ModelRunRecord,
  input: ApplyModelInterventionInput
): ModelRunRecord {
  assertExpectedVersion(run, input.expectedRunVersion);
  if (!input.evidenceId || !run.pendingIntervention || run.activeAttempt) {
    throw new TypeError('model_intervention_not_applicable');
  }
  if (input.disposition === 'safe_retry' && run.pendingIntervention.reason === 'budget_exhausted') {
    throw new TypeError('model_budget_exhausted_cannot_retry');
  }
  if (
    input.disposition === 'safe_retry' && run.pendingIntervention.reason === 'provider_failure' &&
    run.pendingIntervention.providerRetryability !== 'policy'
  ) {
    throw new TypeError('model_provider_failure_not_retryable');
  }
  if (input.disposition === 'safe_retry' && run.pendingIntervention.reason === 'acceptance_unknown' &&
      run.pendingIntervention.providerRecovery !== 'idempotent_reuse') {
    throw new TypeError('ambiguous_model_acceptance_requires_reconciliation');
  }
  if (input.disposition === 'safe_retry' && run.pendingIntervention.reason === 'acceptance_unknown') {
    if (run.pendingIntervention.providerIdempotencySupported !== true) {
      throw new TypeError('model_idempotent_reuse_not_supported');
    }
    if (!run.pendingIntervention.requiredRetryRequestBinding) {
      throw new TypeError('ambiguous_model_retry_binding_missing');
    }
    parseModelRequestBinding(run.pendingIntervention.requiredRetryRequestBinding);
  }
  if (input.disposition === 'safe_retry') {
    assertRetryBudgetAvailable(run);
  }
  if (input.disposition === 'safe_retry' && !input.retryAllowance) {
    throw new TypeError('safe_retry_requires_exact_allowance');
  }
  if (input.disposition !== 'safe_retry' && input.retryAllowance) {
    throw new TypeError('retry_allowance_requires_safe_retry');
  }
  if (input.retryAllowance) {
    assertNonNegative(input.retryAllowance.maximumCostReservationMicros, 'retryAllowance.maximumCostReservationMicros');
    if (input.retryAllowance.maximumCostReservationMicros > run.budget.maxCostMicros) {
      throw new TypeError('model_retry_allowance_exceeds_run_budget');
    }
  }

  const state: ModelRunRecord['state'] = input.disposition === 'safe_retry'
    ? 'queued'
    : input.disposition === 'reconcile'
      ? 'reconciling'
      : input.disposition === 'block' || input.disposition === 'replan' || input.disposition === 'compensate'
        ? 'failed'
        : 'attention';
  if (input.disposition === 'safe_retry') {
    const {
      pendingIntervention: _pendingIntervention,
      safeFailureCode: _safeFailureCode,
      ...runBase
    } = run;
    return freeze({
      ...runBase,
      version: nextVersion(run),
      state,
      lastInterventionEvidenceId: input.evidenceId,
      retryAllowance: {
        evidenceId: input.evidenceId,
        sourceAttemptId: run.pendingIntervention.sourceAttemptId,
        maximumCostReservationMicros: input.retryAllowance!.maximumCostReservationMicros,
        acceptsUnknownUsage: input.retryAllowance!.acceptsUnknownUsage,
        ...(run.pendingIntervention.requiredRetryRequestBinding === undefined
          ? {}
          : { requiredRequestBinding: run.pendingIntervention.requiredRetryRequestBinding })
      },
      updatedAt: input.decidedAt
    });
  }
  return freeze({
    ...run,
    version: nextVersion(run),
    state,
    lastInterventionEvidenceId: input.evidenceId,
    updatedAt: input.decidedAt
  });
}

export function createModelToolCall(input: {
  readonly run: ModelRunRecord;
  readonly attempt: ModelAttemptRecord;
  readonly id: ModelToolCallId;
  readonly sequence: number;
  readonly providerCallId: string;
  readonly operation: { readonly name: string; readonly version: number };
  readonly inputRef: PayloadRef;
  readonly inputBinding: ModelToolInputBinding;
}): ModelToolCallRecord {
  if (input.run.state !== 'waiting_for_tool' || input.attempt.state !== 'tool_requests' || input.attempt.runId !== input.run.id) {
    throw new TypeError('model_tool_call_not_expected');
  }
  assertPositive(input.sequence, 'toolCall.sequence');
  parseModelToolInputBinding(input.inputBinding);
  const inputRef = createPayloadRef(parsePayloadRefId(input.inputRef.id));
  const expected = input.attempt.requestedTools?.find((request) => request.providerCallId === input.providerCallId);
  if (!expected || expected.operation.name !== input.operation.name || expected.operation.version !== input.operation.version) {
    throw new TypeError('model_tool_call_not_declared_by_attempt');
  }
  return freeze({
    id: input.id,
    runId: input.run.id,
    attemptId: input.attempt.id,
    sequence: input.sequence,
    providerCallId: input.providerCallId,
    operation: { ...input.operation },
    inputRef,
    inputBinding: input.inputBinding
  });
}

export function attachModelToolReceipt(
  call: ModelToolCallRecord,
  operationReceiptId: OperationReceiptId
): ModelToolCallRecord {
  if (call.operationReceiptId && call.operationReceiptId !== operationReceiptId) {
    throw new TypeError('model_tool_receipt_conflict');
  }
  return call.operationReceiptId ? call : freeze({ ...call, operationReceiptId });
}

export function resumeModelRunAfterTools(input: {
  readonly run: ModelRunRecord;
  readonly attempt: ModelAttemptRecord;
  readonly calls: readonly ModelToolCallRecord[];
  readonly expectedRunVersion: number;
  readonly resumedAt: UtcInstant;
}): ModelRunRecord {
  assertExpectedVersion(input.run, input.expectedRunVersion);
  if (input.run.state !== 'waiting_for_tool' || input.attempt.state !== 'tool_requests') {
    throw new TypeError('model_run_not_waiting_for_tools');
  }
  const requested = input.attempt.requestedTools ?? [];
  if (requested.length !== input.calls.length) throw new TypeError('model_tool_calls_incomplete');
  const byProviderId = new Map(input.calls.map((call) => [call.providerCallId, call]));
  for (const request of requested) {
    const call = byProviderId.get(request.providerCallId);
    if (!call || call.runId !== input.run.id || call.attemptId !== input.attempt.id || !call.operationReceiptId) {
      throw new TypeError('model_tool_calls_incomplete');
    }
  }
  return freeze({
    ...input.run,
    version: nextVersion(input.run),
    state: 'queued',
    updatedAt: input.resumedAt
  });
}
