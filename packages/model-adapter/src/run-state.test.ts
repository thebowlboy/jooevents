import { describe, expect, test } from 'bun:test';
import {
  createPayloadRef,
  parseAgentRunId,
  parseApprovalId,
  parseAuthorityCitationId,
  parseModelAttemptId,
  parseModelToolCallId,
  parseOperationReceiptId,
  parsePayloadRefId,
  parseUtcInstant
} from '@jooevents/kernel';
import {
  applyModelIntervention,
  attachModelToolReceipt,
  claimModelAttempt,
  confirmModelCancellation,
  createModelRun,
  createModelToolCall,
  parseModelRequestBinding,
  parseModelToolInputBinding,
  reduceModelAttempt,
  recordModelCancellationResult,
  requestModelCancellation,
  resumeModelRunAfterTools
} from '.';

const ids = {
  run: parseAgentRunId('01890f47-9abc-7def-8123-456789abc201'),
  attempt1: parseModelAttemptId('01890f47-9abc-7def-8123-456789abc202'),
  attempt2: parseModelAttemptId('01890f47-9abc-7def-8123-456789abc203'),
  tool: parseModelToolCallId('01890f47-9abc-7def-8123-456789abc204'),
  sourceReceipt: parseOperationReceiptId('01890f47-9abc-7def-8123-456789abc205'),
  toolReceipt: parseOperationReceiptId('01890f47-9abc-7def-8123-456789abc206'),
  citation: parseAuthorityCitationId('01890f47-9abc-7def-8123-456789abc207'),
  input: createPayloadRef(parsePayloadRefId('01890f47-9abc-7def-8123-456789abc208')),
  result: createPayloadRef(parsePayloadRefId('01890f47-9abc-7def-8123-456789abc209')),
  approval: parseApprovalId('01890f47-9abc-7def-8123-456789abc210')
};
const t0 = parseUtcInstant('2026-08-11T00:00:00Z');
const t1 = parseUtcInstant('2026-08-11T00:01:00Z');
const t2 = parseUtcInstant('2026-08-11T00:02:00Z');
const digest = 'a'.repeat(64);

function run() {
  return createModelRun({
    id: ids.run,
    profile: {
      key: 'foundation_fake',
      version: 1,
      digest,
      adapter: { key: 'deterministic_fake', version: 1 }
    },
    scaffold: {
      key: 'foundation_probe', version: 1, digest: 'b'.repeat(64), purpose: 'foundation_probe',
      outputSchema: { key: 'foundation_probe_output', version: 1 }, allowedTools: [{ name: 'foundation.read', version: 1 }]
    },
    sourceOperation: { name: 'start_foundation_probe', version: 1, receiptId: ids.sourceReceipt },
    scopeKey: 'workspace:test',
    authorityCitationId: ids.citation,
    classifiedInputRefs: [ids.input],
    budget: { maximumAttempts: 3, maxInputTokens: 100, maxOutputTokens: 100, maxCostMicros: 100, timeoutMs: 10_000 },
    createdAt: t0
  });
}

function claim(base = run(), attemptId = ids.attempt1) {
  return claimModelAttempt(base, {
    expectedRunVersion: base.version,
    attemptId,
    requestBinding: parseModelRequestBinding(`mrb1_${digest}`),
    executionMode: 'batch',
    costReservationMicros: 50,
    startedAt: t1
  });
}

describe('durable model run state', () => {
  test('a terminal success requires adopted classified output and accounts reported usage', () => {
    const started = claim();
    expect(() => reduceModelAttempt(started.run, started.attempt, {
      expectedRunVersion: started.run.version,
      observation: { kind: 'succeeded', output: { title: 'Event' }, usage: { inputTokens: 10, outputTokens: 4, costMicros: 25 }, evidence: { adapter: { key: 'deterministic_fake', version: 1 }, idempotencySupported: true } },
      finishedAt: t2
    })).toThrow('requires_adopted_payload');
    const reduced = reduceModelAttempt(started.run, started.attempt, {
      expectedRunVersion: started.run.version,
      observation: { kind: 'succeeded', output: { title: 'Event' }, usage: { inputTokens: 10, outputTokens: 4, costMicros: 25 }, evidence: { adapter: { key: 'deterministic_fake', version: 1 }, idempotencySupported: true } },
      adoptedResultRef: ids.result,
      finishedAt: t2
    });
    expect(reduced.run).toMatchObject({ state: 'succeeded', resultRef: ids.result, reservedCostMicros: 0, usage: { attemptsObserved: 1, reportedCostMicros: 25 } });
    expect(reduced.run.usage.missing).toEqual(['cachedInputTokens']);
  });

  test('ambiguous acceptance reconciles and cannot be converted into a blind retry', () => {
    const started = claim();
    const reduced = reduceModelAttempt(started.run, started.attempt, {
      expectedRunVersion: started.run.version,
      observation: { kind: 'acceptance_unknown', recovery: 'manual', evidence: { adapter: { key: 'deterministic_fake', version: 1 }, idempotencySupported: false } },
      finishedAt: t2
    });
    expect(reduced.run.state).toBe('reconciling');
    expect(() => applyModelIntervention(reduced.run, {
      expectedRunVersion: reduced.run.version,
      disposition: 'safe_retry',
      evidenceId: ids.approval,
      retryAllowance: { maximumCostReservationMicros: 50, acceptsUnknownUsage: false },
      decidedAt: t2
    })).toThrow('requires_reconciliation');
    expect(applyModelIntervention(reduced.run, {
      expectedRunVersion: reduced.run.version,
      disposition: 'reconcile',
      evidenceId: ids.approval,
      decidedAt: t2
    }).state).toBe('reconciling');
  });

  test('idempotent ambiguity retry is pinned to the exact frozen request binding', () => {
    const started = claim();
    const reduced = reduceModelAttempt(started.run, started.attempt, {
      expectedRunVersion: started.run.version,
      observation: {
        kind: 'acceptance_unknown',
        recovery: 'idempotent_reuse',
        evidence: { adapter: { key: 'deterministic_fake', version: 1 }, idempotencySupported: true }
      },
      finishedAt: t2
    });
    const approved = applyModelIntervention(reduced.run, {
      expectedRunVersion: reduced.run.version,
      disposition: 'safe_retry',
      evidenceId: ids.approval,
      retryAllowance: { maximumCostReservationMicros: 50, acceptsUnknownUsage: true },
      decidedAt: t2
    });
    expect(approved.retryAllowance).toMatchObject({
      sourceAttemptId: started.attempt.id,
      requiredRequestBinding: started.attempt.requestBinding
    });
    expect(() => claimModelAttempt(approved, {
      expectedRunVersion: approved.version,
      attemptId: ids.attempt2,
      requestBinding: parseModelRequestBinding(`mrb1_${'c'.repeat(64)}`),
      executionMode: 'batch',
      costReservationMicros: 50,
      startedAt: t2
    })).toThrow('model_retry_request_binding_mismatch');
    expect(claimModelAttempt(approved, {
      expectedRunVersion: approved.version,
      attemptId: ids.attempt2,
      requestBinding: started.attempt.requestBinding,
      executionMode: 'batch',
      costReservationMicros: 50,
      startedAt: t2
    }).attempt).toMatchObject({ number: 2, requestBinding: started.attempt.requestBinding });

    const unsupported = claim();
    expect(() => reduceModelAttempt(unsupported.run, unsupported.attempt, {
      expectedRunVersion: unsupported.run.version,
      observation: {
        kind: 'acceptance_unknown',
        recovery: 'idempotent_reuse',
        evidence: { adapter: unsupported.attempt.adapter, idempotencySupported: false }
      },
      finishedAt: t2
    })).toThrow('model_idempotent_reuse_not_supported');
  });

  test('a policy-retryable failure still pauses until exact intervention evidence permits retry', () => {
    const started = claim();
    const reduced = reduceModelAttempt(started.run, started.attempt, {
      expectedRunVersion: started.run.version,
      observation: { kind: 'known_failure', safeCode: 'provider_busy', retryability: 'policy', usage: { inputTokens: 1, outputTokens: 0, cachedInputTokens: 0, costMicros: 1 } },
      finishedAt: t2
    });
    expect(reduced.run.state).toBe('attention');
    const approved = applyModelIntervention(reduced.run, {
      expectedRunVersion: reduced.run.version,
      disposition: 'safe_retry',
      evidenceId: ids.approval,
      retryAllowance: { maximumCostReservationMicros: 50, acceptsUnknownUsage: false },
      decidedAt: t2
    });
    expect(approved).toMatchObject({ state: 'queued', lastInterventionEvidenceId: ids.approval });
    expect(claim(approved, ids.attempt2).attempt.number).toBe(2);
  });

  test('a never-retry provider failure cannot be converted into a safe retry', () => {
    const started = claim();
    const reduced = reduceModelAttempt(started.run, started.attempt, {
      expectedRunVersion: started.run.version,
      observation: {
        kind: 'known_failure',
        safeCode: 'provider_refusal',
        retryability: 'never',
        usage: { inputTokens: 1, outputTokens: 0, cachedInputTokens: 0, costMicros: 1 }
      },
      finishedAt: t2
    });
    expect(reduced.run.pendingIntervention).toMatchObject({
      reason: 'provider_failure',
      providerRetryability: 'never'
    });
    expect(() => applyModelIntervention(reduced.run, {
      expectedRunVersion: reduced.run.version,
      disposition: 'safe_retry',
      evidenceId: ids.approval,
      retryAllowance: { maximumCostReservationMicros: 50, acceptsUnknownUsage: false },
      decidedAt: t2
    })).toThrow('model_provider_failure_not_retryable');
  });

  test('exhausted token or cost ledgers cannot be reopened under the same run budget', () => {
    const started = claim();
    const exceeded = reduceModelAttempt(started.run, started.attempt, {
      expectedRunVersion: started.run.version,
      observation: {
        kind: 'known_failure',
        safeCode: 'provider_busy',
        retryability: 'policy',
        usage: { inputTokens: 101, outputTokens: 0, cachedInputTokens: 0, costMicros: 1 }
      },
      finishedAt: t2
    });
    expect(exceeded.run.state).toBe('exhausted');
    expect(() => applyModelIntervention(exceeded.run, {
      expectedRunVersion: exceeded.run.version,
      disposition: 'safe_retry',
      evidenceId: ids.approval,
      retryAllowance: { maximumCostReservationMicros: 0, acceptsUnknownUsage: false },
      decidedAt: t2
    })).toThrow('model_budget_exhausted_cannot_retry');

    const exactStarted = claim();
    const exactlyConsumed = reduceModelAttempt(exactStarted.run, exactStarted.attempt, {
      expectedRunVersion: exactStarted.run.version,
      observation: {
        kind: 'known_failure',
        safeCode: 'provider_busy',
        retryability: 'policy',
        usage: { inputTokens: 100, outputTokens: 0, cachedInputTokens: 0, costMicros: 1 }
      },
      finishedAt: t2
    });
    expect(() => applyModelIntervention(exactlyConsumed.run, {
      expectedRunVersion: exactlyConsumed.run.version,
      disposition: 'safe_retry',
      evidenceId: ids.approval,
      retryAllowance: { maximumCostReservationMicros: 0, acceptsUnknownUsage: false },
      decidedAt: t2
    })).toThrow('model_usage_budget_exhausted');
  });

  test('invalid provider usage and ledger overflow fail before changing state or reducing budget use', () => {
    for (const [field, value] of [
      ['inputTokens', -1],
      ['outputTokens', Number.NaN],
      ['cachedInputTokens', 1.5],
      ['costMicros', Number.MAX_SAFE_INTEGER + 1]
    ] as const) {
      const started = claim();
      expect(() => reduceModelAttempt(started.run, started.attempt, {
        expectedRunVersion: started.run.version,
        observation: {
          kind: 'known_failure',
          safeCode: 'invalid_provider_usage',
          retryability: 'never',
          usage: { [field]: value }
        },
        finishedAt: t2
      })).toThrow('non-negative safe integer');
      expect(started.run).toMatchObject({ state: 'running', usage: { attemptsObserved: 0, reportedCostMicros: 0 } });
      expect(started.attempt.state).toBe('started');
    }

    const started = claim();
    const corruptLedgerRun: typeof started.run = {
      ...started.run,
      usage: { ...started.run.usage, attemptsObserved: Number.MAX_SAFE_INTEGER }
    };
    expect(() => reduceModelAttempt(corruptLedgerRun, started.attempt, {
      expectedRunVersion: corruptLedgerRun.version,
      observation: { kind: 'known_failure', safeCode: 'provider_busy', retryability: 'never' },
      finishedAt: t2
    })).toThrow('model usage attempts overflow');
  });

  test('attempt reduction rejects mismatched adapter evidence and backwards completion time', () => {
    const started = claim();
    expect(() => reduceModelAttempt(started.run, started.attempt, {
      expectedRunVersion: started.run.version,
      observation: {
        kind: 'acceptance_unknown',
        recovery: 'lookup',
        evidence: { adapter: { key: 'other_adapter', version: 1 }, idempotencySupported: true }
      },
      finishedAt: t2
    })).toThrow('model_observation_adapter_mismatch');
    expect(() => reduceModelAttempt(started.run, started.attempt, {
      expectedRunVersion: started.run.version,
      observation: { kind: 'known_failure', safeCode: 'provider_busy', retryability: 'policy' },
      finishedAt: t0
    })).toThrow('cannot be before attempt start');
  });

  test('tool calls are fixed before invocation and resume only after every receipt exists', () => {
    const started = claim();
    const reduced = reduceModelAttempt(started.run, started.attempt, {
      expectedRunVersion: started.run.version,
      observation: {
        kind: 'tool_requests',
        requests: [{ callId: 'provider-call-1', operation: { name: 'foundation.read', version: 1 }, input: { scope: 'current' } }],
        usage: { inputTokens: 3, outputTokens: 2, cachedInputTokens: 0, costMicros: 2 },
        evidence: { adapter: { key: 'deterministic_fake', version: 1 }, idempotencySupported: true }
      },
      finishedAt: t2
    });
    const call = createModelToolCall({
      run: reduced.run,
      attempt: reduced.attempt,
      id: ids.tool,
      sequence: 1,
      providerCallId: 'provider-call-1',
      operation: { name: 'foundation.read', version: 1 },
      inputRef: ids.input,
      inputBinding: parseModelToolInputBinding(`mtb1_${'c'.repeat(64)}`)
    });
    expect(() => resumeModelRunAfterTools({ run: reduced.run, attempt: reduced.attempt, calls: [call], expectedRunVersion: reduced.run.version, resumedAt: t2 })).toThrow('incomplete');
    const completed = attachModelToolReceipt(call, ids.toolReceipt);
    expect(resumeModelRunAfterTools({ run: reduced.run, attempt: reduced.attempt, calls: [completed], expectedRunVersion: reduced.run.version, resumedAt: t2 }).state).toBe('queued');
  });

  test('unknown cost evidence requires a bounded renewed approval before another paid attempt', () => {
    const started = claim();
    const reduced = reduceModelAttempt(started.run, started.attempt, {
      expectedRunVersion: started.run.version,
      observation: { kind: 'known_failure', safeCode: 'provider_busy', retryability: 'policy' },
      finishedAt: t2
    });
    const approved = applyModelIntervention(reduced.run, {
      expectedRunVersion: reduced.run.version,
      disposition: 'safe_retry',
      evidenceId: ids.approval,
      retryAllowance: { maximumCostReservationMicros: 25, acceptsUnknownUsage: false },
      decidedAt: t2
    });
    expect(() => claim(approved, ids.attempt2)).toThrow('usage_unknown_requires_intervention');
    const explicitlyApproved = applyModelIntervention(reduced.run, {
      expectedRunVersion: reduced.run.version,
      disposition: 'safe_retry',
      evidenceId: ids.approval,
      retryAllowance: { maximumCostReservationMicros: 25, acceptsUnknownUsage: true },
      decidedAt: t2
    });
    expect(() => claim(explicitlyApproved, ids.attempt2)).toThrow('retry_allowance_exceeded');
    expect(claimModelAttempt(explicitlyApproved, {
      expectedRunVersion: explicitlyApproved.version,
      attemptId: ids.attempt2,
      requestBinding: parseModelRequestBinding(`mrb1_${digest}`),
      executionMode: 'batch',
      costReservationMicros: 25,
      startedAt: t2
    }).attempt.number).toBe(2);
  });

  test('cancellation request and confirmation use the exact active fence and retain usage evidence', () => {
    const started = claim();
    expect(() => requestModelCancellation(started.run, {
      expectedRunVersion: started.run.version,
      expectedActiveAttempt: { id: started.attempt.id, fence: started.attempt.fence + 1 },
      requestedAt: t2
    })).toThrow('stale_model_attempt_fence');

    const requested = requestModelCancellation(started.run, {
      expectedRunVersion: started.run.version,
      expectedActiveAttempt: { id: started.attempt.id, fence: started.attempt.fence },
      requestedAt: t2
    });
    expect(requested).toMatchObject({
      state: 'cancel_requested',
      reservedCostMicros: 50,
      activeAttempt: { id: started.attempt.id, fence: started.attempt.fence }
    });
    const confirmed = confirmModelCancellation(requested, started.attempt, {
      expectedRunVersion: requested.version,
      expectedAttemptId: started.attempt.id,
      expectedFence: started.attempt.fence,
      observation: {
        kind: 'cancelled',
        usage: { inputTokens: 2, outputTokens: 1, cachedInputTokens: 0, costMicros: 3 },
        evidence: {
          adapter: { key: 'deterministic_fake', version: 1 },
          providerRequestId: `fake:${started.attempt.id}`,
          idempotencySupported: true,
          executionMode: 'batch'
        }
      },
      finishedAt: t2
    });
    expect(confirmed.run).toMatchObject({
      state: 'cancelled',
      reservedCostMicros: 0,
      usage: { attemptsObserved: 1, reportedInputTokens: 2, reportedOutputTokens: 1, reportedCostMicros: 3 }
    });
    expect(confirmed.run.activeAttempt).toBeUndefined();
    expect(confirmed.attempt).toMatchObject({ state: 'cancelled', usage: { costMicros: 3 } });
    expect(() => confirmModelCancellation(confirmed.run, confirmed.attempt, {
      expectedRunVersion: confirmed.run.version,
      expectedAttemptId: confirmed.attempt.id,
      expectedFence: confirmed.attempt.fence,
      observation: { kind: 'cancelled' },
      finishedAt: t2
    })).toThrow('stale_model_attempt_fence');
  });

  test('every provider cancellation result has an explicit recoverable transition', () => {
    for (const [kind, expectedState, safeFailureCode] of [
      ['cancelled', 'reconciling', undefined],
      ['too_late', 'reconciling', 'model_cancellation_too_late_reconcile'],
      ['unknown', 'reconciling', 'model_cancellation_unknown_reconcile'],
      ['unsupported', 'running', 'model_cancellation_unsupported_continuing']
    ] as const) {
      const started = claim();
      const requested = requestModelCancellation(started.run, {
        expectedRunVersion: started.run.version,
        expectedActiveAttempt: { id: started.attempt.id, fence: started.attempt.fence },
        requestedAt: t2
      });
      const resolved = recordModelCancellationResult(requested, started.attempt, {
        expectedRunVersion: requested.version,
        expectedAttemptId: started.attempt.id,
        expectedFence: started.attempt.fence,
        observation: { kind },
        observedAt: t2
      });
      expect(resolved).toMatchObject({
        state: expectedState,
        lastCancellationResult: {
          attemptId: started.attempt.id,
          fence: started.attempt.fence,
          outcome: kind
        }
      });
      if (safeFailureCode === undefined) expect(resolved.safeFailureCode).toBeUndefined();
      else expect(resolved.safeFailureCode).toBe(safeFailureCode);

      if (kind === 'cancelled') {
        expect(() => reduceModelAttempt(resolved, started.attempt, {
          expectedRunVersion: resolved.version,
          observation: {
            kind: 'known_failure',
            safeCode: 'provider_terminal_after_cancel_request',
            retryability: 'never',
            evidence: { adapter: started.attempt.adapter, idempotencySupported: true }
          },
          finishedAt: t2
        })).toThrow('stale_model_attempt_fence');
        expect(confirmModelCancellation(resolved, started.attempt, {
          expectedRunVersion: resolved.version,
          expectedAttemptId: started.attempt.id,
          expectedFence: started.attempt.fence,
          observation: {
            kind: 'cancelled',
            evidence: { adapter: started.attempt.adapter, idempotencySupported: true }
          },
          finishedAt: t2
        }).run.state).toBe('cancelled');
      } else {
        const terminal = reduceModelAttempt(resolved, started.attempt, {
          expectedRunVersion: resolved.version,
          observation: {
            kind: 'known_failure',
            safeCode: 'provider_terminal_after_cancel_request',
            retryability: 'never',
            evidence: { adapter: started.attempt.adapter, idempotencySupported: true }
          },
          finishedAt: t2
        });
        expect(terminal.run.state).toBe('attention');
        expect(terminal.run.lastCancellationResult).toBeUndefined();
      }
    }

    const started = claim();
    const requested = requestModelCancellation(started.run, {
      expectedRunVersion: started.run.version,
      expectedActiveAttempt: { id: started.attempt.id, fence: started.attempt.fence },
      requestedAt: t2
    });
    expect(() => recordModelCancellationResult(requested, started.attempt, {
      expectedRunVersion: requested.version,
      expectedAttemptId: started.attempt.id,
      expectedFence: started.attempt.fence + 1,
      observation: { kind: 'unknown' },
      observedAt: t2
    })).toThrow('stale_model_attempt_fence');
    expect(() => recordModelCancellationResult(requested, started.attempt, {
      expectedRunVersion: requested.version,
      expectedAttemptId: started.attempt.id,
      expectedFence: started.attempt.fence,
      observation: { kind: 'unknown' },
      observedAt: t1
    })).toThrow('before cancellation request');
    expect(() => recordModelCancellationResult(requested, started.attempt, {
      expectedRunVersion: requested.version,
      expectedAttemptId: started.attempt.id,
      expectedFence: started.attempt.fence,
      observation: { kind: 'not_a_cancellation_result' } as never,
      observedAt: t2
    })).toThrow('invalid_model_cancellation_result');

    const tooLate = recordModelCancellationResult(requested, started.attempt, {
      expectedRunVersion: requested.version,
      expectedAttemptId: started.attempt.id,
      expectedFence: started.attempt.fence,
      observation: { kind: 'too_late' },
      observedAt: t2
    });
    expect(() => confirmModelCancellation(tooLate, started.attempt, {
      expectedRunVersion: tooLate.version,
      expectedAttemptId: started.attempt.id,
      expectedFence: started.attempt.fence,
      observation: { kind: 'cancelled' },
      finishedAt: t2
    })).toThrow('model_cancellation_requires_reconciliation');
    expect(() => confirmModelCancellation(requested, started.attempt, {
      expectedRunVersion: requested.version,
      expectedAttemptId: started.attempt.id,
      expectedFence: started.attempt.fence,
      observation: { kind: 'too_late' } as never,
      finishedAt: t2
    })).toThrow('invalid_model_cancellation_confirmation');
  });
});
