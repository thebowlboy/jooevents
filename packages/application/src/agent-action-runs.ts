import {
  agentActionBatchViewSchema,
  agentActionPlanSchema,
  type AgentActionApproval,
  type AgentActionBatchView,
  type AgentActionPlan,
  type AgentActionStep
} from '@jooevents/contracts';
import { canonicalJsonSha256, canonicalJsonText } from '@jooevents/kernel';

export interface AgentActionEligibleOperation {
  readonly operationName: string;
  readonly operationVersion: number;
  readonly contractDigestSha256: string;
  readonly batchable: boolean;
  readonly externalEffect: 'none' | 'reconcilable';
  validateInput(input: unknown): unknown;
  hashRequest(input: unknown): string;
  displayLabel(input: unknown): string;
  consequences(input: unknown): readonly string[];
}

export interface AgentActionEligibilityCatalog {
  resolve(operationName: string, operationVersion: number): AgentActionEligibleOperation | undefined;
}

export interface FrozenAgentActionPlan {
  readonly plan: AgentActionPlan;
  readonly canonicalPlanJson: string;
  readonly planDigestSha256: string;
}

function identity(step: Pick<AgentActionStep, 'operationName' | 'operationVersion'>): string {
  return `${step.operationName}@${step.operationVersion}`;
}

export function freezeAgentActionPlan(
  candidate: unknown,
  catalog: AgentActionEligibilityCatalog
): FrozenAgentActionPlan {
  const plan = agentActionPlanSchema.parse(candidate);
  if (plan.bounds.maximumActions !== plan.steps.length) {
    throw new TypeError('agent_action_bounds_mismatch');
  }
  if (Date.parse(plan.bounds.expiresAt) <= Date.parse(plan.submittedAt)) {
    throw new TypeError('agent_action_plan_expired_at_submission');
  }
  const allowed = new Set(plan.bounds.allowedOperationIdentities);
  if (allowed.size !== plan.bounds.allowedOperationIdentities.length) {
    throw new TypeError('agent_action_allowed_operation_duplicate');
  }
  const ids = new Set<string>();
  for (const [index, step] of plan.steps.entries()) {
    if (step.ordinal !== index + 1) throw new TypeError('agent_action_step_order_invalid');
    if (ids.has(step.id)) throw new TypeError('agent_action_step_id_duplicate');
    ids.add(step.id);
    const operationIdentity = identity(step);
    if (!allowed.has(operationIdentity)) throw new TypeError('agent_action_operation_out_of_bounds');
    const operation = catalog.resolve(step.operationName, step.operationVersion);
    if (!operation?.batchable) throw new TypeError('agent_action_operation_ineligible');
    if (operation.contractDigestSha256 !== step.contractDigestSha256) {
      throw new TypeError('agent_action_contract_changed');
    }
    if (operation.externalEffect !== step.externalEffect) {
      throw new TypeError('agent_action_external_effect_mismatch');
    }
    const canonicalInput = operation.validateInput(step.input);
    if (canonicalJsonText(canonicalInput) !== canonicalJsonText(step.input)) {
      throw new TypeError('agent_action_input_noncanonical');
    }
    if (operation.hashRequest(canonicalInput) !== step.requestHashSha256) {
      throw new TypeError('agent_action_request_hash_changed');
    }
    if (operation.displayLabel(canonicalInput) !== step.displayLabel
      || canonicalJsonText(operation.consequences(canonicalInput)) !== canonicalJsonText(step.consequences)) {
      throw new TypeError('agent_action_presentation_changed');
    }
  }
  const canonicalPlanJson = canonicalJsonText(plan);
  return Object.freeze({
    plan: Object.freeze(plan),
    canonicalPlanJson,
    planDigestSha256: canonicalJsonSha256(plan)
  });
}

export interface AgentActionLease {
  readonly batchId: string;
  readonly workerId: string;
  readonly leaseVersion: number;
  readonly leaseExpiresAt: string;
}

export interface AgentActionRunRepository {
  submit(frozen: FrozenAgentActionPlan): AgentActionBatchView;
  inspect(batchId: string): AgentActionBatchView | undefined;
  list(input?: { readonly status?: AgentActionBatchView['status']; readonly limit?: number }): readonly AgentActionBatchView[];
  approve(input: {
    readonly batchId: string;
    readonly expectedVersion: number;
    readonly expectedPlanDigestSha256: string;
    readonly approval: AgentActionApproval;
  }): AgentActionBatchView;
  reject(input: { readonly batchId: string; readonly expectedVersion: number; readonly reason: string; readonly at: string }): AgentActionBatchView;
  requestPause(input: { readonly batchId: string; readonly expectedVersion: number; readonly at: string }): AgentActionBatchView;
  requestCancel(input: { readonly batchId: string; readonly expectedVersion: number; readonly at: string }): AgentActionBatchView;
  resume(input: { readonly batchId: string; readonly expectedVersion: number; readonly at: string }): AgentActionBatchView;
  acquireLease(input: { readonly batchId: string; readonly workerId: string; readonly now: string; readonly leaseExpiresAt: string }): AgentActionLease | undefined;
  nextStep(lease: AgentActionLease): AgentActionStep | undefined;
  markStepRunning(input: { readonly lease: AgentActionLease; readonly stepId: string; readonly now: string }): AgentActionBatchView;
  pauseStep(input: { readonly lease: AgentActionLease; readonly stepId: string; readonly outcome: unknown; readonly now: string; readonly externalWait: boolean }): AgentActionBatchView;
  settleSafeBoundary(input: { readonly lease: AgentActionLease; readonly now: string }): AgentActionBatchView;
  failBatch(input: { readonly lease: AgentActionLease; readonly detail: unknown; readonly now: string }): AgentActionBatchView;
}

export interface AgentActionCurrentAuthority {
  recheck(input: {
    readonly batch: AgentActionBatchView;
    readonly step: AgentActionStep;
    readonly now: string;
  }):
    | { readonly kind: 'allowed' }
    | { readonly kind: 'paused'; readonly reason: string; readonly detail?: unknown };
}

export interface AgentActionRegisteredExecutor {
  execute(input: {
    readonly batch: AgentActionBatchView;
    readonly step: AgentActionStep;
    readonly lease: AgentActionLease;
    readonly semanticIdempotencyKey: string;
    readonly now: string;
  }): Promise<
    | { readonly kind: 'succeeded'; readonly terminalLogId: string }
    | { readonly kind: 'paused'; readonly outcome: unknown }
    | { readonly kind: 'waiting_external'; readonly outcome: unknown }
  >;
}

export interface ApprovedAgentActionOperationExecutionPort {
  /**
   * Executes one exact registry-selected operation in process. Implementations own
   * the operation's ordinary unit of work and atomically persist its domain
   * contribution, compact operation log, and the supplied step success.
   */
  executeRegistered(input: {
    readonly operation: {
      readonly name: string;
      readonly version: number;
      readonly contractDigestSha256: string;
    };
    readonly businessInput: unknown;
    readonly approval: AgentActionApproval;
    readonly planDigestSha256: string;
    readonly source: AgentActionPlan['source'];
    readonly scope: AgentActionPlan['scope'];
    readonly guards: AgentActionStep['guards'];
    readonly batchId: string;
    readonly stepId: string;
    readonly stepOrdinal: number;
    readonly lease: AgentActionLease;
    readonly semanticIdempotencyKey: string;
    readonly now: string;
  }): Promise<
    | { readonly kind: 'succeeded'; readonly terminalLogId: string }
    | { readonly kind: 'paused'; readonly outcome: unknown }
    | { readonly kind: 'waiting_external'; readonly outcome: unknown }
  >;
}

/**
 * The only runner-to-operation composition seam. It cannot receive a database
 * handle or URL and refuses any operation or request that no longer matches the
 * compiled eligibility catalog and frozen executable envelope.
 */
export function createRegisteredAgentActionExecutor(input: {
  readonly catalog: AgentActionEligibilityCatalog;
  readonly operationExecutor: ApprovedAgentActionOperationExecutionPort;
}): AgentActionRegisteredExecutor {
  return Object.freeze({
    async execute(request: Parameters<AgentActionRegisteredExecutor['execute']>[0]) {
      const approval = request.batch.approval;
      if (approval === null || approval.planDigestSha256 !== request.batch.planDigestSha256) {
        throw new TypeError('agent_action_registered_executor_approval_invalid');
      }
      const frozenStep = request.batch.plan.steps.find((step) => step.id === request.step.id);
      if (frozenStep === undefined || canonicalJsonText(frozenStep) !== canonicalJsonText(request.step)) {
        throw new TypeError('agent_action_registered_executor_step_not_frozen');
      }
      const operation = input.catalog.resolve(request.step.operationName, request.step.operationVersion);
      if (!operation?.batchable
        || operation.contractDigestSha256 !== request.step.contractDigestSha256
        || operation.externalEffect !== request.step.externalEffect) {
        throw new TypeError('agent_action_registered_executor_operation_unavailable');
      }
      const parsedInput = operation.validateInput(request.step.input);
      if (operation.hashRequest(parsedInput) !== request.step.requestHashSha256
        || operation.displayLabel(parsedInput) !== request.step.displayLabel
        || canonicalJsonText(operation.consequences(parsedInput)) !== canonicalJsonText(request.step.consequences)) {
        throw new TypeError('agent_action_registered_executor_envelope_changed');
      }
      return input.operationExecutor.executeRegistered({
        operation: {
          name: operation.operationName,
          version: operation.operationVersion,
          contractDigestSha256: operation.contractDigestSha256
        },
        businessInput: parsedInput,
        approval,
        planDigestSha256: request.batch.planDigestSha256,
        source: request.batch.plan.source,
        scope: request.batch.plan.scope,
        guards: request.step.guards,
        batchId: request.batch.plan.batchId,
        stepId: request.step.id,
        stepOrdinal: request.step.ordinal,
        lease: request.lease,
        semanticIdempotencyKey: request.semanticIdempotencyKey,
        now: request.now
      });
    }
  });
}

export function agentActionSemanticIdempotencyKey(batchId: string, step: AgentActionStep): string {
  return `agent-action:${batchId}:step:${step.ordinal}:${step.operationName}@${step.operationVersion}`;
}

export function createAgentActionRunner(input: {
  readonly repository: AgentActionRunRepository;
  readonly catalog: AgentActionEligibilityCatalog;
  readonly authority: AgentActionCurrentAuthority;
  readonly executor: AgentActionRegisteredExecutor;
  readonly now: () => string;
  readonly leaseDurationMs: number;
}) {
  if (!Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs < 1_000) {
    throw new TypeError('agent_action_lease_duration_invalid');
  }
  return Object.freeze({
    async advance(batchId: string, workerId: string): Promise<AgentActionBatchView> {
      const now = input.now();
      const lease = input.repository.acquireLease({
        batchId,
        workerId,
        now,
        leaseExpiresAt: new Date(Date.parse(now) + input.leaseDurationMs).toISOString()
      });
      const current = input.repository.inspect(batchId);
      if (!current) throw new TypeError('agent_action_batch_missing');
      if (!lease) return current;
      if (current.pauseRequested || current.cancelRequested) {
        return input.repository.settleSafeBoundary({ lease, now });
      }
      const step = input.repository.nextStep(lease);
      if (!step) return input.repository.settleSafeBoundary({ lease, now });
      const approval = current.approval;
      const operation = input.catalog.resolve(step.operationName, step.operationVersion);
      let runtimeStaleReason = approval === null
        ? 'approval_missing'
        : approval.planDigestSha256 !== current.planDigestSha256
          ? 'plan_digest_changed'
          : Date.parse(approval.approvalExpiresAt) <= Date.parse(now)
            ? 'approval_expired'
            : Date.parse(current.plan.bounds.expiresAt) <= Date.parse(now)
              ? 'plan_expired'
              : canonicalJsonText(approval.approvedBounds) !== canonicalJsonText(current.plan.bounds)
                ? 'approval_bounds_changed'
                : !operation?.batchable
                  ? 'operation_ineligible'
                  : operation.contractDigestSha256 !== step.contractDigestSha256
                    ? 'operation_contract_changed'
                    : operation.externalEffect !== step.externalEffect
                      ? 'operation_external_effect_changed'
                      : undefined;
      if (runtimeStaleReason === undefined && operation !== undefined) {
        try {
          const parsedInput = operation.validateInput(step.input);
          runtimeStaleReason = operation.hashRequest(parsedInput) !== step.requestHashSha256
            ? 'request_changed'
            : operation.displayLabel(parsedInput) !== step.displayLabel
              || canonicalJsonText(operation.consequences(parsedInput)) !== canonicalJsonText(step.consequences)
              ? 'presentation_changed'
              : undefined;
        } catch {
          runtimeStaleReason = 'request_changed';
        }
      }
      if (runtimeStaleReason !== undefined) {
        return input.repository.pauseStep({
          lease,
          stepId: step.id,
          outcome: { reason: runtimeStaleReason },
          now,
          externalWait: false
        });
      }
      const authority = input.authority.recheck({ batch: current, step, now });
      if (authority.kind === 'paused') {
        return input.repository.pauseStep({
          lease,
          stepId: step.id,
          outcome: { reason: authority.reason, detail: authority.detail ?? null },
          now,
          externalWait: false
        });
      }
      const running = input.repository.markStepRunning({ lease, stepId: step.id, now });
      const result = await input.executor.execute({
        batch: running,
        step,
        lease,
        semanticIdempotencyKey: agentActionSemanticIdempotencyKey(batchId, step),
        now
      });
      if (result.kind === 'succeeded') {
        const after = input.repository.inspect(batchId);
        if (!after) throw new TypeError('agent_action_batch_missing_after_execution');
        const persisted = after.steps.find((candidate) => candidate.id === step.id);
        if (persisted?.status !== 'succeeded' || persisted.terminalLogId !== result.terminalLogId) {
          throw new TypeError('agent_action_executor_did_not_commit_step_atomically');
        }
        return input.repository.settleSafeBoundary({ lease, now });
      }
      return input.repository.pauseStep({
        lease,
        stepId: step.id,
        outcome: result.outcome,
        now,
        externalWait: result.kind === 'waiting_external'
      });
    }
  });
}

export function parseAgentActionBatchView(value: unknown): AgentActionBatchView {
  return agentActionBatchViewSchema.parse(value);
}

/** Mutation surface admitted for external MCP and app-model callers. */
export interface AgentActionPlanSurface {
  submit(candidate: unknown): AgentActionBatchView;
  inspect(batchId: string): AgentActionBatchView | undefined;
  cancel(input: { readonly batchId: string; readonly expectedVersion: number }): AgentActionBatchView;
}

export function createAgentActionPlanSurface(input: {
  readonly repository: AgentActionRunRepository;
  readonly catalog: AgentActionEligibilityCatalog;
  readonly now: () => string;
}): AgentActionPlanSurface {
  return Object.freeze({
    submit(candidate: unknown) {
      return input.repository.submit(freezeAgentActionPlan(candidate, input.catalog));
    },
    inspect(batchId: string) {
      return input.repository.inspect(batchId);
    },
    cancel(request: { readonly batchId: string; readonly expectedVersion: number }) {
      return input.repository.requestCancel({ ...request, at: input.now() });
    }
  });
}
