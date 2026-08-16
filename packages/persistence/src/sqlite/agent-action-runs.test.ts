import { describe, expect, test } from 'bun:test';
import {
  createAgentActionRunner,
  createRegisteredAgentActionExecutor,
  freezeAgentActionPlan,
  type AgentActionCurrentAuthority,
  type AgentActionEligibilityCatalog,
  type AgentActionEligibleOperation,
  type ApprovedAgentActionOperationExecutionPort
} from '@jooevents/application';
import type { AgentActionApproval, AgentActionPlan, AgentActionStep } from '@jooevents/contracts';
import { canonicalJsonSha256, canonicalJsonText } from '@jooevents/kernel';
import { Database } from 'bun:sqlite';
import { FOUNDATION_TRIAL_UOW_SQL } from './foundation-trial-uow';
import {
  AGENT_ACTION_RUN_SQL,
  SQLiteAgentActionRunRepository,
  type AgentActionMutationObserver
} from './agent-action-runs';

const uuid = (suffix: number): string =>
  `019c1df8-96b5-769b-bba4-${suffix.toString(16).padStart(12, '0')}`;
const contractDigest = 'a'.repeat(64);
const registryDigest = 'b'.repeat(64);

interface MutableOperation extends AgentActionEligibleOperation {
  requestSalt: string;
  currentContractDigest: string;
}

function eligibleOperation(externalEffect: 'none' | 'reconcilable' = 'none'): MutableOperation {
  return {
    operationName: 'fixture.mutate', operationVersion: 1,
    currentContractDigest: contractDigest,
    get contractDigestSha256() { return this.currentContractDigest; },
    batchable: true, externalEffect, requestSalt: '',
    validateInput(value: unknown) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('fixture_input_invalid');
      const record = value as Record<string, unknown>;
      if (Object.keys(record).some((key) => !['action', 'value'].includes(key))
        || !['set', 'forward_correction'].includes(String(record.action))
        || typeof record.value !== 'string') throw new TypeError('fixture_input_invalid');
      return value;
    },
    hashRequest(value: unknown) { return canonicalJsonSha256({ value, salt: this.requestSalt }); },
    displayLabel(value: unknown) {
      const parsed = this.validateInput(value) as { readonly action: string };
      return parsed.action === 'forward_correction' ? 'Correct fixture forward' : 'Set fixture';
    },
    consequences: () => ['Two current fixture rows change.']
  };
}

function catalog(operation: MutableOperation): AgentActionEligibilityCatalog {
  return { resolve: (name, version) => name === operation.operationName && version === 1 ? operation : undefined };
}

function candidate(input: {
  batchSuffix?: number;
  count?: number;
  externalEffect?: 'none' | 'reconcilable';
  correctionAt?: number;
} = {}, operation = eligibleOperation(input.externalEffect)): AgentActionPlan {
  const count = input.count ?? 1;
  const batchId = uuid(input.batchSuffix ?? 1);
  const steps = Array.from({ length: count }, (_, index) => {
    const stepInput = {
      action: index + 1 === input.correctionAt ? 'forward_correction' : 'set',
      value: `value-${index + 1}`
    };
    return {
      id: uuid(100 + index), ordinal: index + 1,
      operationName: operation.operationName, operationVersion: operation.operationVersion,
      contractDigestSha256: operation.contractDigestSha256, input: stepInput,
      requestHashSha256: operation.hashRequest(stepInput),
      guards: [{ kind: 'fixture_version', expected: index }],
      subjects: [{ type: 'event', id: uuid(3) }],
      displayLabel: index + 1 === input.correctionAt ? 'Correct fixture forward' : 'Set fixture',
      consequences: ['Two current fixture rows change.'], externalEffect: operation.externalEffect
    } satisfies AgentActionStep;
  });
  return {
    schemaVersion: 1, batchId,
    source: { surface: 'app_model', clientKey: 'fixture.plan', proposingPrincipalId: 'model-profile.fixture' },
    scope: { workspaceId: uuid(2), eventId: uuid(3), subjects: [{ type: 'event', id: uuid(3) }] },
    intent: 'Apply the approved fixture changes in order.', registryDigestSha256: registryDigest,
    bounds: { maximumActions: count, expiresAt: '2026-08-16T02:00:00.000Z', allowedOperationIdentities: ['fixture.mutate@1'] },
    steps, submittedAt: '2026-08-16T00:00:00.000Z'
  };
}

function approval(planDigestSha256: string, bounds: AgentActionPlan['bounds']): AgentActionApproval {
  return {
    approvedByPrincipalId: 'user.eligible-owner', planDigestSha256,
    approvedAt: '2026-08-16T00:01:00.000Z', approvalExpiresAt: '2026-08-16T01:30:00.000Z',
    approvalPolicy: { key: 'agent-action.eligible-human', version: 1 }, approvedBounds: bounds
  };
}

type ExecutionMode = 'success' | 'before_commit_crash' | 'after_commit_crash' | 'wait_external' | 'pause';

function harness(input: {
  plan?: AgentActionPlan;
  operation?: MutableOperation;
  now?: string;
  eligible?: boolean;
  authority?: AgentActionCurrentAuthority;
  mutationObserver?: AgentActionMutationObserver;
} = {}) {
  const operation = input.operation ?? eligibleOperation(input.plan?.steps[0]?.externalEffect);
  const plan = input.plan ?? candidate({}, operation);
  const sqlite = new Database(':memory:', { strict: true });
  sqlite.exec('PRAGMA foreign_keys=ON;');
  sqlite.exec(FOUNDATION_TRIAL_UOW_SQL);
  sqlite.exec(AGENT_ACTION_RUN_SQL);
  sqlite.exec(`CREATE TABLE fixture_domain (
    batch_id TEXT NOT NULL, step_id TEXT NOT NULL, row_number INTEGER NOT NULL,
    value TEXT NOT NULL, PRIMARY KEY(batch_id,step_id,row_number)
  ) STRICT, WITHOUT ROWID;`);
  const repository = new SQLiteAgentActionRunRepository(
    sqlite,
    ({ plan: approvedPlan, approval: proposedApproval }) =>
      (input.eligible ?? true)
      && approvedPlan.source.surface === 'app_model'
      && proposedApproval.approvedByPrincipalId === 'user.eligible-owner',
    input.mutationObserver
  );
  const frozen = freezeAgentActionPlan(plan, catalog(operation));
  const submitted = repository.submit(frozen);
  let now = input.now ?? '2026-08-16T00:02:00.000Z';
  let mode: ExecutionMode = 'success';
  let authorityCalls = 0;
  const registeredRequests: Parameters<ApprovedAgentActionOperationExecutionPort['executeRegistered']>[0][] = [];

  function insertStep(step: AgentActionStep, batchId: string, semanticKey: string, at: string): string {
    const stepInput = operation.validateInput(step.input) as { readonly action: string; readonly value: string };
    const logId = uuid(1000 + step.ordinal);
    const correlationId = uuid(2000 + step.ordinal);
    repository.runStepOperationAtomically({
      lease: currentLease!, stepId: step.id, now: at,
      operation: () => {
        const domainInsert = sqlite.query(`INSERT INTO fixture_domain(batch_id,step_id,row_number,value) VALUES (?,?,?,?)`);
        domainInsert.run(batchId, step.id, 1, `${stepInput.value}:a`);
        domainInsert.run(batchId, step.id, 2, `${stepInput.value}:b`);
        const receipt = { id: logId, operationName: step.operationName, operationVersion: step.operationVersion };
        const result = { kind: 'success', data: { action: stepInput.action }, receipt, correlationId };
        sqlite.query(`INSERT INTO operation_log (
          id,operation_name,operation_version,registry_digest_sha256,surface,actor_json,
          authority_principal_key,workspace_id,event_id,subjects_json,summary,occurred_at_ms,
          correlation_id,scope_partition_key,idempotency_verifier_profile_key,
          idempotency_verifier_profile_version,idempotency_key_verifier,request_hash,result_json,
          action_batch_id,action_step_id
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          logId, step.operationName, step.operationVersion, registryDigest, 'app_model',
          canonicalJsonText({ kind: 'approved_agent_action', principalId: 'user.eligible-owner' }),
          'user.eligible-owner', uuid(2), uuid(3), canonicalJsonText([{ kind: 'event', id: uuid(3) }]),
          stepInput.action === 'forward_correction' ? 'Corrected the fixture forward' : 'Updated the fixture',
          Date.parse(at), correlationId, 'c'.repeat(64), 'agent-action.semantic-key', 1,
          canonicalJsonSha256(semanticKey), step.requestHashSha256, canonicalJsonText(result), batchId, step.id
        );
        return { terminalLogId: logId, value: undefined };
      }
    });
    return logId;
  }

  let currentLease: Parameters<SQLiteAgentActionRunRepository['runStepOperationAtomically']>[0]['lease'] | undefined;
  const operationExecutor: ApprovedAgentActionOperationExecutionPort = {
    async executeRegistered(context) {
      registeredRequests.push(context);
      currentLease = context.lease;
      if (mode === 'before_commit_crash') throw new Error('simulated_crash_before_commit');
      if (mode === 'wait_external') return { kind: 'waiting_external', outcome: { state: 'provider_unknown' } };
      if (mode === 'pause') return { kind: 'paused', outcome: { reason: 'guard_stale' } };
      const step = plan.steps.find((candidate) => candidate.id === context.stepId)!;
      const terminalLogId = insertStep(step, context.batchId, context.semanticIdempotencyKey, context.now);
      if (mode === 'after_commit_crash') throw new Error('simulated_crash_after_commit');
      return { kind: 'succeeded', terminalLogId };
    }
  };
  const executor = createRegisteredAgentActionExecutor({
    catalog: catalog(operation), operationExecutor
  });
  const authority: AgentActionCurrentAuthority = input.authority ?? {
    recheck({ batch, step }) {
      authorityCalls += 1;
      if (batch.approval?.approvedByPrincipalId !== 'user.eligible-owner'
        || batch.plan.source.proposingPrincipalId !== 'model-profile.fixture'
        || batch.plan.scope.eventId !== uuid(3)
        || step.guards.length !== 1) return { kind: 'paused', reason: 'current_authority_or_guard_changed' };
      return { kind: 'allowed' };
    }
  };
  const runner = createAgentActionRunner({
    repository, catalog: catalog(operation), authority, executor, now: () => now, leaseDurationMs: 60_000
  });
  return {
    sqlite, repository, operation, frozen, submitted, runner,
    approve() { return repository.approve({ batchId: plan.batchId, expectedVersion: 1, expectedPlanDigestSha256: frozen.planDigestSha256, approval: approval(frozen.planDigestSha256, plan.bounds) }); },
    setNow(value: string) { now = value; }, setMode(value: ExecutionMode) { mode = value; },
    get authorityCalls() { return authorityCalls; },
    get registeredRequests() { return registeredRequests; },
    count(table: string) { return sqlite.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`).get()!.count; }
  };
}

describe('SQLite approved agent action runs', () => {
  test('executes five ordered steps through one unchanged executor and proves 34 logical mutations', async () => {
    const counts = new Map<string, number>();
    const observer: AgentActionMutationObserver = { record(kind, count = 1) { counts.set(kind, (counts.get(kind) ?? 0) + count); } };
    const operation = eligibleOperation();
    const testRun = harness({ plan: candidate({ count: 5, correctionAt: 5 }, operation), operation, mutationObserver: observer });
    try {
      testRun.approve();
      for (let index = 0; index < 5; index += 1) {
        const view = await testRun.runner.advance(testRun.frozen.plan.batchId, 'worker-a');
        expect(view.steps.filter((step) => step.status === 'succeeded')).toHaveLength(index + 1);
      }
      const final = testRun.repository.inspect(testRun.frozen.plan.batchId)!;
      expect(final.status).toBe('succeeded');
      expect(final.steps.map((step) => step.ordinal)).toEqual([1, 2, 3, 4, 5]);
      expect(testRun.authorityCalls).toBe(5);
      expect(testRun.registeredRequests).toHaveLength(5);
      expect(testRun.registeredRequests.map((request) => request.operation))
        .toEqual(Array.from({ length: 5 }, () => ({
          name: 'fixture.mutate', version: 1, contractDigestSha256: contractDigest
        })));
      const executorWire = canonicalJsonText(testRun.registeredRequests[0]);
      expect(executorWire).not.toContain('http');
      expect(executorWire).not.toContain('sqlite');
      expect(executorWire).not.toContain('database');
      expect(testRun.registeredRequests[0]?.approval.approvedByPrincipalId).toBe('user.eligible-owner');
      expect(testRun.registeredRequests[0]?.source.surface).toBe('app_model');
      expect(testRun.count('fixture_domain')).toBe(10);
      expect(testRun.count('operation_log')).toBe(5);
      expect(testRun.sqlite.query<{ summary: string }, []>(`SELECT summary FROM operation_log ORDER BY occurred_at_ms DESC,id DESC LIMIT 1`).get()?.summary)
        .toBe('Corrected the fixture forward');
      const lifecycleMutations = [...counts.values()].reduce((sum, value) => sum + value, 0);
      expect(lifecycleMutations).toBe(19);
      expect(lifecycleMutations + testRun.count('fixture_domain') + testRun.count('operation_log')).toBe(34);
    } finally { testRun.sqlite.close(); }
  });

  test('recovers crashes before and after the atomic domain-log-step commit without replaying state', async () => {
    const before = harness();
    try {
      before.approve(); before.setMode('before_commit_crash');
      await expect(before.runner.advance(before.frozen.plan.batchId, 'worker-a')).rejects.toThrow('simulated_crash_before_commit');
      expect(before.count('fixture_domain')).toBe(0); expect(before.count('operation_log')).toBe(0);
      before.setMode('success'); before.setNow('2026-08-16T00:04:00.000Z');
      expect((await before.runner.advance(before.frozen.plan.batchId, 'worker-b')).status).toBe('succeeded');
      expect(before.count('fixture_domain')).toBe(2); expect(before.count('operation_log')).toBe(1);
    } finally { before.sqlite.close(); }

    const after = harness({ plan: candidate({ batchSuffix: 10 }) });
    try {
      after.approve(); after.setMode('after_commit_crash');
      await expect(after.runner.advance(after.frozen.plan.batchId, 'worker-a')).rejects.toThrow('simulated_crash_after_commit');
      expect(after.count('fixture_domain')).toBe(2); expect(after.count('operation_log')).toBe(1);
      after.setMode('success'); after.setNow('2026-08-16T00:04:00.000Z');
      expect((await after.runner.advance(after.frozen.plan.batchId, 'worker-b')).status).toBe('succeeded');
      expect(after.count('fixture_domain')).toBe(2); expect(after.count('operation_log')).toBe(1);
      expect((await after.runner.advance(after.frozen.plan.batchId, 'worker-c')).status).toBe('succeeded');
    } finally { after.sqlite.close(); }
  });

  test('leases one worker, pauses revoked authority, and fails closed on runtime contract/request changes', async () => {
    const leaseRun = harness();
    try {
      leaseRun.approve();
      const first = leaseRun.repository.acquireLease({ batchId: leaseRun.frozen.plan.batchId, workerId: 'worker-a', now: '2026-08-16T00:02:00.000Z', leaseExpiresAt: '2026-08-16T00:03:00.000Z' });
      expect(first).toBeDefined();
      expect(leaseRun.repository.acquireLease({ batchId: leaseRun.frozen.plan.batchId, workerId: 'worker-b', now: '2026-08-16T00:02:01.000Z', leaseExpiresAt: '2026-08-16T00:03:01.000Z' })).toBeUndefined();
    } finally { leaseRun.sqlite.close(); }

    const revoked = harness({ authority: { recheck: () => ({ kind: 'paused', reason: 'source_authority_revoked' }) } });
    try {
      revoked.approve();
      const view = await revoked.runner.advance(revoked.frozen.plan.batchId, 'worker-a');
      expect(view.status).toBe('paused'); expect(view.safeStatusDetail).toEqual({ reason: 'source_authority_revoked', detail: null });
      expect(revoked.count('fixture_domain')).toBe(0); expect(revoked.count('operation_log')).toBe(0);
    } finally { revoked.sqlite.close(); }

    const stale = harness();
    try {
      stale.approve(); stale.operation.currentContractDigest = 'd'.repeat(64);
      const view = await stale.runner.advance(stale.frozen.plan.batchId, 'worker-a');
      expect(view.status).toBe('paused'); expect(view.safeStatusDetail).toEqual({ reason: 'operation_contract_changed' });
    } finally { stale.sqlite.close(); }

    const changed = harness({ plan: candidate({ batchSuffix: 11 }) });
    try {
      changed.approve(); changed.operation.requestSalt = 'changed';
      const view = await changed.runner.advance(changed.frozen.plan.batchId, 'worker-a');
      expect(view.status).toBe('paused'); expect(view.safeStatusDetail).toEqual({ reason: 'request_changed' });
    } finally { changed.sqlite.close(); }
  });

  test('shows partial state, cancels only the remainder, and keeps correction as a forward operation', async () => {
    const operation = eligibleOperation();
    const testRun = harness({ plan: candidate({ batchSuffix: 12, count: 3, correctionAt: 3 }, operation), operation });
    try {
      testRun.approve();
      const partial = await testRun.runner.advance(testRun.frozen.plan.batchId, 'worker-a');
      expect(partial.status).toBe('running'); expect(partial.steps[0]?.status).toBe('succeeded');
      const cancelled = testRun.repository.requestCancel({ batchId: testRun.frozen.plan.batchId, expectedVersion: partial.version, at: '2026-08-16T00:02:10.000Z' });
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.steps.map((step) => step.status)).toEqual(['succeeded', 'cancelled', 'cancelled']);
      expect(testRun.count('fixture_domain')).toBe(2);
      expect(JSON.stringify(cancelled.plan)).toContain('forward_correction');
      expect(JSON.stringify(cancelled.plan)).not.toContain('compensat');
    } finally { testRun.sqlite.close(); }
  });

  test('requires explicit reconciliation for an ambiguous external wait before resume', async () => {
    const operation = eligibleOperation('reconcilable');
    const testRun = harness({ plan: candidate({ batchSuffix: 13, externalEffect: 'reconcilable' }, operation), operation });
    try {
      testRun.approve(); testRun.setMode('wait_external');
      const waiting = await testRun.runner.advance(testRun.frozen.plan.batchId, 'worker-a');
      expect(waiting.status).toBe('paused'); expect(waiting.steps[0]?.status).toBe('waiting_external');
      expect(() => testRun.repository.resume({ batchId: waiting.plan.batchId, expectedVersion: waiting.version, at: '2026-08-16T00:03:00.000Z' }))
        .toThrow('agent_action_external_reconciliation_required');
      const reconciled = testRun.repository.reconcileExternal({ batchId: waiting.plan.batchId, stepId: waiting.steps[0]!.id, safeRetry: true, outcome: { provider: 'no_effect_observed' }, at: '2026-08-16T00:03:00.000Z' });
      const resumed = testRun.repository.resume({ batchId: waiting.plan.batchId, expectedVersion: reconciled.version, at: '2026-08-16T00:03:01.000Z' });
      expect(resumed.status).toBe('queued');
      testRun.setMode('success'); testRun.setNow('2026-08-16T00:03:02.000Z');
      expect((await testRun.runner.advance(waiting.plan.batchId, 'worker-b')).status).toBe('succeeded');
    } finally { testRun.sqlite.close(); }
  });

  test('binds approval to eligibility, exact digest, bounds, and unexpired execution time', async () => {
    const ineligible = harness({ eligible: false });
    try { expect(() => ineligible.approve()).toThrow('agent_action_approver_ineligible'); }
    finally { ineligible.sqlite.close(); }

    const modelApproval = harness({ plan: candidate({ batchSuffix: 16 }) });
    try {
      const forged = {
        ...approval(modelApproval.frozen.planDigestSha256, modelApproval.frozen.plan.bounds),
        approvedByPrincipalId: 'model-profile.fixture'
      };
      expect(() => modelApproval.repository.approve({
        batchId: modelApproval.frozen.plan.batchId,
        expectedVersion: 1,
        expectedPlanDigestSha256: modelApproval.frozen.planDigestSha256,
        approval: forged
      })).toThrow('agent_action_approver_ineligible');
      expect(modelApproval.registeredRequests).toHaveLength(0);
    } finally { modelApproval.sqlite.close(); }

    const digest = harness({ plan: candidate({ batchSuffix: 14 }) });
    try {
      const wrong = approval('f'.repeat(64), digest.frozen.plan.bounds);
      expect(() => digest.repository.approve({ batchId: digest.frozen.plan.batchId, expectedVersion: 1, expectedPlanDigestSha256: digest.frozen.planDigestSha256, approval: wrong }))
        .toThrow('agent_action_approval_stale');
    } finally { digest.sqlite.close(); }

    const expired = harness({ plan: candidate({ batchSuffix: 15 }), now: '2026-08-16T01:31:00.000Z' });
    try {
      expired.approve();
      const view = await expired.runner.advance(expired.frozen.plan.batchId, 'worker-a');
      expect(view.status).toBe('paused'); expect(view.safeStatusDetail).toEqual({ reason: 'approval_expired' });
    } finally { expired.sqlite.close(); }
  });
});
