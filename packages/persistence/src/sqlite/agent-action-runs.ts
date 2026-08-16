import type {
  AgentActionLease,
  AgentActionRunRepository,
  FrozenAgentActionPlan
} from '@jooevents/application';
import {
  agentActionApprovalSchema,
  agentActionBatchViewSchema,
  agentActionPlanSchema,
  type AgentActionApproval,
  type AgentActionBatchStatus,
  type AgentActionBatchView,
  type AgentActionStep
} from '@jooevents/contracts';
import { canonicalJsonText } from '@jooevents/kernel';
import { Database } from 'bun:sqlite';

export const AGENT_ACTION_RUN_SQL = `
CREATE TABLE agent_action_batches (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  plan_json TEXT NOT NULL CHECK(json_valid(plan_json) AND json_extract(plan_json, '$.batchId') = id),
  plan_digest_sha256 TEXT NOT NULL UNIQUE CHECK(length(plan_digest_sha256) = 64 AND plan_digest_sha256 NOT GLOB '*[^0-9a-f]*'),
  registry_digest_sha256 TEXT NOT NULL CHECK(length(registry_digest_sha256) = 64 AND registry_digest_sha256 NOT GLOB '*[^0-9a-f]*'),
  source_surface TEXT NOT NULL CHECK(source_surface IN ('external_mcp', 'app_model')),
  source_principal_id TEXT NOT NULL CHECK(length(source_principal_id) BETWEEN 1 AND 256),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT CHECK(event_id IS NULL OR length(event_id) = 36),
  bounds_json TEXT NOT NULL CHECK(json_valid(bounds_json) AND json_type(bounds_json) = 'object'),
  status TEXT NOT NULL CHECK(status IN ('awaiting_approval','rejected','queued','running','paused','cancel_requested','cancelled','failed','succeeded')),
  version INTEGER NOT NULL CHECK(version > 0),
  current_ordinal INTEGER NOT NULL CHECK(current_ordinal > 0),
  approved_plan_digest_sha256 TEXT,
  approved_by_principal_id TEXT,
  approved_at_ms INTEGER,
  approval_expires_at_ms INTEGER,
  approval_policy_key TEXT,
  approval_policy_version INTEGER,
  approved_bounds_json TEXT,
  pause_requested INTEGER NOT NULL DEFAULT 0 CHECK(pause_requested IN (0,1)),
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),
  lease_owner TEXT,
  lease_version INTEGER NOT NULL DEFAULT 0 CHECK(lease_version >= 0),
  lease_expires_at_ms INTEGER,
  safe_status_detail_json TEXT CHECK(safe_status_detail_json IS NULL OR json_valid(safe_status_detail_json)),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
  CHECK((lease_owner IS NULL) = (lease_expires_at_ms IS NULL)),
  CHECK(
    (approved_plan_digest_sha256 IS NULL AND approved_by_principal_id IS NULL AND approved_at_ms IS NULL
      AND approval_expires_at_ms IS NULL AND approval_policy_key IS NULL
      AND approval_policy_version IS NULL AND approved_bounds_json IS NULL)
    OR
    (approved_plan_digest_sha256 IS NOT NULL AND approved_by_principal_id IS NOT NULL AND approved_at_ms IS NOT NULL
      AND approval_expires_at_ms IS NOT NULL AND approval_policy_key IS NOT NULL
      AND approval_policy_version > 0 AND json_valid(approved_bounds_json))
  )
) STRICT, WITHOUT ROWID;

CREATE TABLE agent_action_steps (
  batch_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK(length(id) = 36),
  ordinal INTEGER NOT NULL CHECK(ordinal > 0),
  operation_name TEXT NOT NULL CHECK(length(operation_name) BETWEEN 1 AND 160),
  operation_version INTEGER NOT NULL CHECK(operation_version > 0),
  contract_digest_sha256 TEXT NOT NULL CHECK(length(contract_digest_sha256) = 64 AND contract_digest_sha256 NOT GLOB '*[^0-9a-f]*'),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  request_hash_sha256 TEXT NOT NULL CHECK(length(request_hash_sha256) = 64 AND request_hash_sha256 NOT GLOB '*[^0-9a-f]*'),
  guards_json TEXT NOT NULL CHECK(json_valid(guards_json) AND json_type(guards_json) = 'array'),
  subjects_json TEXT NOT NULL CHECK(json_valid(subjects_json) AND json_type(subjects_json) = 'array'),
  display_label TEXT NOT NULL CHECK(length(display_label) BETWEEN 1 AND 160),
  consequences_json TEXT NOT NULL CHECK(json_valid(consequences_json) AND json_type(consequences_json) = 'array'),
  external_effect TEXT NOT NULL CHECK(external_effect IN ('none','reconcilable')),
  semantic_idempotency_key TEXT NOT NULL CHECK(length(semantic_idempotency_key) BETWEEN 1 AND 512),
  status TEXT NOT NULL CHECK(status IN ('pending','running','waiting_external','needs_attention','cancelled','succeeded')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  last_safe_outcome_json TEXT CHECK(last_safe_outcome_json IS NULL OR json_valid(last_safe_outcome_json)),
  terminal_log_id TEXT,
  started_at_ms INTEGER,
  completed_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
  PRIMARY KEY(batch_id, id),
  UNIQUE(batch_id, ordinal),
  UNIQUE(semantic_idempotency_key),
  UNIQUE(batch_id, id, ordinal),
  FOREIGN KEY(batch_id) REFERENCES agent_action_batches(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(terminal_log_id) REFERENCES operation_log(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX agent_action_batches_status_updated
  ON agent_action_batches(status, updated_at_ms DESC, id);
CREATE INDEX agent_action_steps_next
  ON agent_action_steps(batch_id, status, ordinal);

CREATE TRIGGER agent_action_batches_frozen_plan
BEFORE UPDATE ON agent_action_batches
WHEN NEW.plan_json IS NOT OLD.plan_json
  OR NEW.plan_digest_sha256 IS NOT OLD.plan_digest_sha256
  OR NEW.registry_digest_sha256 IS NOT OLD.registry_digest_sha256
  OR NEW.source_surface IS NOT OLD.source_surface
  OR NEW.source_principal_id IS NOT OLD.source_principal_id
  OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.event_id IS NOT OLD.event_id
  OR NEW.bounds_json IS NOT OLD.bounds_json
  OR NEW.created_at_ms IS NOT OLD.created_at_ms
BEGIN SELECT RAISE(ABORT, 'agent action batch plan is immutable'); END;

CREATE TRIGGER agent_action_steps_frozen_plan
BEFORE UPDATE ON agent_action_steps
WHEN NEW.batch_id IS NOT OLD.batch_id OR NEW.id IS NOT OLD.id OR NEW.ordinal IS NOT OLD.ordinal
  OR NEW.operation_name IS NOT OLD.operation_name OR NEW.operation_version IS NOT OLD.operation_version
  OR NEW.contract_digest_sha256 IS NOT OLD.contract_digest_sha256 OR NEW.input_json IS NOT OLD.input_json
  OR NEW.request_hash_sha256 IS NOT OLD.request_hash_sha256 OR NEW.guards_json IS NOT OLD.guards_json
  OR NEW.subjects_json IS NOT OLD.subjects_json OR NEW.display_label IS NOT OLD.display_label
  OR NEW.consequences_json IS NOT OLD.consequences_json OR NEW.external_effect IS NOT OLD.external_effect
  OR NEW.semantic_idempotency_key IS NOT OLD.semantic_idempotency_key
BEGIN SELECT RAISE(ABORT, 'agent action step plan is immutable'); END;
`;

interface BatchRow {
  id: string; plan_json: string; plan_digest_sha256: string; status: AgentActionBatchStatus;
  version: number; current_ordinal: number; approved_plan_digest_sha256: string | null;
  approved_by_principal_id: string | null; approved_at_ms: number | null;
  approval_expires_at_ms: number | null; approval_policy_key: string | null;
  approval_policy_version: number | null; approved_bounds_json: string | null;
  pause_requested: number; cancel_requested: number; safe_status_detail_json: string | null;
  created_at_ms: number; updated_at_ms: number;
}
interface StepRow {
  batch_id: string; id: string; ordinal: number; operation_name: string; operation_version: number;
  contract_digest_sha256: string; input_json: string; request_hash_sha256: string;
  guards_json: string; subjects_json: string; display_label: string; consequences_json: string;
  external_effect: 'none' | 'reconcilable'; status: AgentActionBatchView['steps'][number]['status'];
  attempt_count: number; last_safe_outcome_json: string | null; terminal_log_id: string | null;
  started_at_ms: number | null; completed_at_ms: number | null;
}

function instant(ms: number): string { return new Date(ms).toISOString(); }
function millis(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new TypeError('agent_action_instant_invalid');
  return parsed;
}
function semanticKey(batchId: string, step: AgentActionStep): string {
  return `agent-action:${batchId}:step:${step.ordinal}:${step.operationName}@${step.operationVersion}`;
}

export interface AgentActionMutationObserver {
  record(kind: 'batch_inserted' | 'steps_inserted' | 'batch_approved' | 'batch_running' | 'step_running' | 'step_succeeded' | 'batch_succeeded' | 'batch_other', count?: number): void;
}

export class SQLiteAgentActionRunRepository implements AgentActionRunRepository {
  constructor(
    readonly sqlite: Database,
    private readonly approvalEligibility: (input: { readonly plan: AgentActionBatchView['plan']; readonly approval: AgentActionApproval }) => boolean,
    private readonly mutations?: AgentActionMutationObserver
  ) {}

  private transaction<Value>(work: () => Value): Value {
    if (this.sqlite.inTransaction) return work();
    return this.sqlite.transaction(work)();
  }

  submit(frozen: FrozenAgentActionPlan): AgentActionBatchView {
    return this.transaction(() => {
      const plan = agentActionPlanSchema.parse(frozen.plan);
      const at = millis(plan.submittedAt);
      this.sqlite.query(`
        INSERT INTO agent_action_batches (
          id, plan_json, plan_digest_sha256, registry_digest_sha256, source_surface,
          source_principal_id, workspace_id, event_id, bounds_json, status, version,
          current_ordinal, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_approval', 1, 1, ?, ?)
      `).run(plan.batchId, frozen.canonicalPlanJson, frozen.planDigestSha256,
        plan.registryDigestSha256, plan.source.surface, plan.source.proposingPrincipalId,
        plan.scope.workspaceId, plan.scope.eventId ?? null, canonicalJsonText(plan.bounds), at, at);
      this.mutations?.record('batch_inserted');
      const insert = this.sqlite.query(`
        INSERT INTO agent_action_steps (
          batch_id,id,ordinal,operation_name,operation_version,contract_digest_sha256,
          input_json,request_hash_sha256,guards_json,subjects_json,display_label,
          consequences_json,external_effect,semantic_idempotency_key,status,updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `);
      for (const step of plan.steps) insert.run(plan.batchId, step.id, step.ordinal,
        step.operationName, step.operationVersion, step.contractDigestSha256,
        canonicalJsonText(step.input), step.requestHashSha256, canonicalJsonText(step.guards),
        canonicalJsonText(step.subjects), step.displayLabel, canonicalJsonText(step.consequences),
        step.externalEffect, semanticKey(plan.batchId, step), at);
      this.mutations?.record('steps_inserted', plan.steps.length);
      return this.require(plan.batchId);
    });
  }

  inspect(batchId: string): AgentActionBatchView | undefined {
    const batch = this.sqlite.query<BatchRow, [string]>('SELECT * FROM agent_action_batches WHERE id = ?').get(batchId);
    return batch ? this.view(batch) : undefined;
  }
  private require(batchId: string): AgentActionBatchView {
    const view = this.inspect(batchId);
    if (!view) throw new TypeError('agent_action_batch_missing');
    return view;
  }
  list(input: { readonly status?: AgentActionBatchStatus; readonly limit?: number } = {}): readonly AgentActionBatchView[] {
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError('agent_action_list_limit_invalid');
    const rows = input.status
      ? this.sqlite.query<BatchRow, [string, number]>('SELECT * FROM agent_action_batches WHERE status = ? ORDER BY updated_at_ms DESC,id LIMIT ?').all(input.status, limit)
      : this.sqlite.query<BatchRow, [number]>('SELECT * FROM agent_action_batches ORDER BY updated_at_ms DESC,id LIMIT ?').all(limit);
    return Object.freeze(rows.map((row) => this.view(row)));
  }

  approve(input: { batchId: string; expectedVersion: number; expectedPlanDigestSha256: string; approval: AgentActionApproval }): AgentActionBatchView {
    return this.transaction(() => {
      const current = this.require(input.batchId);
      const approval = agentActionApprovalSchema.parse(input.approval);
      if (current.status !== 'awaiting_approval' || current.version !== input.expectedVersion
        || current.planDigestSha256 !== input.expectedPlanDigestSha256
        || approval.planDigestSha256 !== current.planDigestSha256
        || canonicalJsonText(approval.approvedBounds) !== canonicalJsonText(current.plan.bounds)) {
        throw new TypeError('agent_action_approval_stale');
      }
      if (!this.approvalEligibility({ plan: current.plan, approval })) throw new TypeError('agent_action_approver_ineligible');
      if (millis(approval.approvalExpiresAt) > millis(current.plan.bounds.expiresAt)
        || millis(approval.approvalExpiresAt) <= millis(approval.approvedAt)) {
        throw new TypeError('agent_action_approval_bounds_invalid');
      }
      this.sqlite.query(`UPDATE agent_action_batches SET status='queued',version=version+1,
        approved_plan_digest_sha256=?,approved_by_principal_id=?,approved_at_ms=?,approval_expires_at_ms=?,
        approval_policy_key=?,approval_policy_version=?,approved_bounds_json=?,updated_at_ms=?
        WHERE id=? AND version=?`).run(current.planDigestSha256, approval.approvedByPrincipalId,
        millis(approval.approvedAt), millis(approval.approvalExpiresAt), approval.approvalPolicy.key,
        approval.approvalPolicy.version, canonicalJsonText(approval.approvedBounds), millis(approval.approvedAt),
        input.batchId, input.expectedVersion);
      this.mutations?.record('batch_approved');
      return this.require(input.batchId);
    });
  }

  reject(input: { batchId: string; expectedVersion: number; reason: string; at: string }): AgentActionBatchView {
    return this.updateBatchStatus(input.batchId, input.expectedVersion, ['awaiting_approval'], 'rejected', input.at, { reason: input.reason });
  }
  requestPause(input: { batchId: string; expectedVersion: number; at: string }): AgentActionBatchView {
    const current = this.require(input.batchId);
    if (!['queued','running'].includes(current.status) || current.version !== input.expectedVersion) throw new TypeError('agent_action_pause_stale');
    this.sqlite.query(`UPDATE agent_action_batches SET pause_requested=1,version=version+1,updated_at_ms=? WHERE id=? AND version=?`)
      .run(millis(input.at), input.batchId, input.expectedVersion);
    this.mutations?.record('batch_other');
    return this.require(input.batchId);
  }
  requestCancel(input: { batchId: string; expectedVersion: number; at: string }): AgentActionBatchView {
    return this.transaction(() => {
      const current = this.require(input.batchId);
      if (!['awaiting_approval','queued','running','paused','cancel_requested'].includes(current.status)
        || current.version !== input.expectedVersion) throw new TypeError('agent_action_cancel_stale');
      const running = current.steps.some((step) => step.status === 'running');
      if (!running) {
        this.sqlite.query(`UPDATE agent_action_steps SET status='cancelled',updated_at_ms=? WHERE batch_id=? AND status IN ('pending','needs_attention','waiting_external')`)
          .run(millis(input.at), input.batchId);
      }
      this.sqlite.query(`UPDATE agent_action_batches SET status=?,cancel_requested=1,version=version+1,
        lease_owner=CASE WHEN ? THEN lease_owner ELSE NULL END,
        lease_expires_at_ms=CASE WHEN ? THEN lease_expires_at_ms ELSE NULL END,
        updated_at_ms=? WHERE id=? AND version=?`)
        .run(running ? 'cancel_requested' : 'cancelled', running ? 1 : 0, running ? 1 : 0,
          millis(input.at), input.batchId, input.expectedVersion);
      this.mutations?.record('batch_other');
      return this.require(input.batchId);
    });
  }
  resume(input: { batchId: string; expectedVersion: number; at: string }): AgentActionBatchView {
    return this.transaction(() => {
      const current = this.require(input.batchId);
      if (current.status !== 'paused' || current.version !== input.expectedVersion) throw new TypeError('agent_action_resume_stale');
      if (current.steps.some((step) => step.status === 'waiting_external')) throw new TypeError('agent_action_external_reconciliation_required');
      this.sqlite.query(`UPDATE agent_action_steps SET status='pending',updated_at_ms=? WHERE batch_id=? AND status='needs_attention'`)
        .run(millis(input.at), input.batchId);
      this.sqlite.query(`UPDATE agent_action_batches SET status='queued',pause_requested=0,version=version+1,
        safe_status_detail_json=NULL,updated_at_ms=? WHERE id=? AND version=?`)
        .run(millis(input.at), input.batchId, input.expectedVersion);
      this.mutations?.record('batch_other');
      return this.require(input.batchId);
    });
  }

  acquireLease(input: { batchId: string; workerId: string; now: string; leaseExpiresAt: string }): AgentActionLease | undefined {
    const now = millis(input.now); const expiry = millis(input.leaseExpiresAt);
    if (expiry <= now) throw new TypeError('agent_action_lease_expiry_invalid');
    return this.transaction(() => {
      const row = this.sqlite.query<{ status: string; lease_owner: string | null; lease_expires_at_ms: number | null }, [string]>(
        'SELECT status,lease_owner,lease_expires_at_ms FROM agent_action_batches WHERE id=?'
      ).get(input.batchId);
      if (!row || !['queued','running','cancel_requested'].includes(row.status)
        || (row.lease_owner !== null && row.lease_owner !== input.workerId && (row.lease_expires_at_ms ?? 0) > now)) return undefined;
      const orphan = this.sqlite.query<{ id: string; external_effect: 'none' | 'reconcilable' }, [string]>(
        `SELECT id,external_effect FROM agent_action_steps WHERE batch_id=? AND status='running' ORDER BY ordinal LIMIT 1`
      ).get(input.batchId);
      if (orphan && (row.lease_owner === null || (row.lease_expires_at_ms ?? 0) <= now)) {
        if (orphan.external_effect === 'reconcilable') {
          this.sqlite.query(`UPDATE agent_action_steps SET status='waiting_external',last_safe_outcome_json=?,updated_at_ms=?
            WHERE batch_id=? AND id=? AND status='running'`).run(canonicalJsonText({ reason: 'external_effect_reconciliation_required_after_lease_loss' }), now, input.batchId, orphan.id);
          this.sqlite.query(`UPDATE agent_action_batches SET status='paused',version=version+1,
            safe_status_detail_json=?,lease_owner=NULL,lease_expires_at_ms=NULL,updated_at_ms=? WHERE id=?`)
            .run(canonicalJsonText({ reason: 'external_effect_reconciliation_required_after_lease_loss' }), now, input.batchId);
          this.mutations?.record('batch_other');
          return undefined;
        }
        this.sqlite.query(`UPDATE agent_action_steps SET status='pending',updated_at_ms=?
          WHERE batch_id=? AND id=? AND status='running'`).run(now, input.batchId, orphan.id);
      }
      const changed = this.sqlite.query(`UPDATE agent_action_batches SET status=CASE WHEN status='queued' THEN 'running' ELSE status END,
        version=version+1,lease_owner=?,lease_version=lease_version+1,lease_expires_at_ms=?,updated_at_ms=? WHERE id=?
        AND (lease_owner IS NULL OR lease_owner=? OR lease_expires_at_ms<=?)`).run(input.workerId, expiry, now, input.batchId, input.workerId, now);
      if (changed.changes !== 1) return undefined;
      if (row.status === 'queued') this.mutations?.record('batch_running');
      const leased = this.sqlite.query<{ lease_version: number }, [string]>('SELECT lease_version FROM agent_action_batches WHERE id=?').get(input.batchId);
      return Object.freeze({ batchId: input.batchId, workerId: input.workerId, leaseVersion: leased!.lease_version, leaseExpiresAt: input.leaseExpiresAt });
    });
  }
  nextStep(lease: AgentActionLease): AgentActionStep | undefined {
    this.assertLease(lease);
    const view = this.require(lease.batchId);
    const next = view.steps.find((candidate) => !['succeeded','cancelled'].includes(candidate.status));
    if (!next) return undefined;
    return view.plan.steps.find((candidate) => candidate.id === next.id);
  }
  markStepRunning(input: { lease: AgentActionLease; stepId: string; now: string }): AgentActionBatchView {
    this.assertLease(input.lease);
    const changed = this.sqlite.query(`UPDATE agent_action_steps SET status='running',attempt_count=attempt_count+1,
      started_at_ms=COALESCE(started_at_ms,?),updated_at_ms=? WHERE batch_id=? AND id=? AND status IN ('pending','needs_attention')`)
      .run(millis(input.now), millis(input.now), input.lease.batchId, input.stepId);
    if (changed.changes !== 1) throw new TypeError('agent_action_step_start_stale');
    this.mutations?.record('step_running');
    return this.require(input.lease.batchId);
  }
  pauseStep(input: { lease: AgentActionLease; stepId: string; outcome: unknown; now: string; externalWait: boolean }): AgentActionBatchView {
    return this.transaction(() => {
      this.assertLease(input.lease);
      this.sqlite.query(`UPDATE agent_action_steps SET status=?,last_safe_outcome_json=?,updated_at_ms=?
        WHERE batch_id=? AND id=? AND status IN ('pending','running','needs_attention','waiting_external')`)
        .run(input.externalWait ? 'waiting_external' : 'needs_attention', canonicalJsonText(input.outcome), millis(input.now), input.lease.batchId, input.stepId);
      this.sqlite.query(`UPDATE agent_action_batches SET status='paused',version=version+1,safe_status_detail_json=?,
        lease_owner=NULL,lease_expires_at_ms=NULL,updated_at_ms=? WHERE id=?`).run(canonicalJsonText(input.outcome), millis(input.now), input.lease.batchId);
      this.mutations?.record('batch_other');
      return this.require(input.lease.batchId);
    });
  }
  settleSafeBoundary(input: { lease: AgentActionLease; now: string }): AgentActionBatchView {
    return this.transaction(() => {
      this.assertLease(input.lease);
      const current = this.require(input.lease.batchId);
      if (current.cancelRequested || current.status === 'cancel_requested') {
        this.sqlite.query(`UPDATE agent_action_steps SET status='cancelled',updated_at_ms=? WHERE batch_id=? AND status IN ('pending','needs_attention','waiting_external')`)
          .run(millis(input.now), input.lease.batchId);
        this.finishBatch(input.lease.batchId, 'cancelled', input.now, null);
      } else if (current.pauseRequested) {
        this.finishBatch(input.lease.batchId, 'paused', input.now, null);
      } else if (current.steps.every((step) => step.status === 'succeeded')) {
        this.finishBatch(input.lease.batchId, 'succeeded', input.now, null);
        this.mutations?.record('batch_succeeded');
      } else {
        const ordinal = current.steps.find((step) => step.status !== 'succeeded')?.ordinal ?? current.steps.length + 1;
        this.sqlite.query(`UPDATE agent_action_batches SET current_ordinal=?,updated_at_ms=? WHERE id=?`).run(ordinal, millis(input.now), input.lease.batchId);
      }
      return this.require(input.lease.batchId);
    });
  }
  failBatch(input: { lease: AgentActionLease; detail: unknown; now: string }): AgentActionBatchView {
    this.assertLease(input.lease);
    this.finishBatch(input.lease.batchId, 'failed', input.now, input.detail);
    return this.require(input.lease.batchId);
  }

  runStepOperationAtomically<Value>(input: {
    readonly lease: AgentActionLease; readonly stepId: string; readonly now: string;
    readonly operation: () => { readonly terminalLogId: string; readonly value: Value };
  }): Value {
    return this.transaction(() => {
      this.assertLease(input.lease);
      const step = this.sqlite.query<{ status: string }, [string, string]>('SELECT status FROM agent_action_steps WHERE batch_id=? AND id=?').get(input.lease.batchId, input.stepId);
      if (step?.status === 'succeeded') throw new TypeError('agent_action_step_already_succeeded');
      if (step?.status !== 'running') throw new TypeError('agent_action_step_not_running');
      const result = input.operation();
      const changed = this.sqlite.query(`UPDATE agent_action_steps SET status='succeeded',terminal_log_id=?,
        last_safe_outcome_json=NULL,completed_at_ms=?,updated_at_ms=? WHERE batch_id=? AND id=? AND status='running'`)
        .run(result.terminalLogId, millis(input.now), millis(input.now), input.lease.batchId, input.stepId);
      if (changed.changes !== 1) throw new TypeError('agent_action_step_success_stale');
      this.mutations?.record('step_succeeded');
      return result.value;
    });
  }

  reconcileExternal(input: { batchId: string; stepId: string; safeRetry: boolean; outcome: unknown; at: string }): AgentActionBatchView {
    return this.transaction(() => {
      const changed = this.sqlite.query(`UPDATE agent_action_steps SET status=?,last_safe_outcome_json=?,updated_at_ms=?
        WHERE batch_id=? AND id=? AND status='waiting_external'`).run(input.safeRetry ? 'needs_attention' : 'waiting_external', canonicalJsonText(input.outcome), millis(input.at), input.batchId, input.stepId);
      if (changed.changes !== 1) throw new TypeError('agent_action_external_reconciliation_stale');
      return this.require(input.batchId);
    });
  }

  private assertLease(lease: AgentActionLease): void {
    const row = this.sqlite.query<{ lease_owner: string | null; lease_version: number; lease_expires_at_ms: number | null }, [string]>(
      'SELECT lease_owner,lease_version,lease_expires_at_ms FROM agent_action_batches WHERE id=?'
    ).get(lease.batchId);
    if (!row || row.lease_owner !== lease.workerId || row.lease_version !== lease.leaseVersion
      || row.lease_expires_at_ms !== millis(lease.leaseExpiresAt)) throw new TypeError('agent_action_lease_lost');
  }
  private finishBatch(batchId: string, status: AgentActionBatchStatus, at: string, detail: unknown): void {
    this.sqlite.query(`UPDATE agent_action_batches SET status=?,version=version+1,current_ordinal=(SELECT count(*)+1 FROM agent_action_steps WHERE batch_id=?),
      safe_status_detail_json=?,lease_owner=NULL,lease_expires_at_ms=NULL,updated_at_ms=? WHERE id=?`)
      .run(status, batchId, detail === null ? null : canonicalJsonText(detail), millis(at), batchId);
  }
  private updateBatchStatus(batchId: string, version: number, allowed: readonly AgentActionBatchStatus[], status: AgentActionBatchStatus, at: string, detail: unknown): AgentActionBatchView {
    const current = this.require(batchId);
    if (!allowed.includes(current.status) || current.version !== version) throw new TypeError('agent_action_batch_status_stale');
    this.sqlite.query(`UPDATE agent_action_batches SET status=?,version=version+1,safe_status_detail_json=?,updated_at_ms=? WHERE id=? AND version=?`)
      .run(status, canonicalJsonText(detail), millis(at), batchId, version);
    this.mutations?.record('batch_other');
    return this.require(batchId);
  }
  private view(row: BatchRow): AgentActionBatchView {
    const plan = agentActionPlanSchema.parse(JSON.parse(row.plan_json));
    const steps = this.sqlite.query<StepRow, [string]>('SELECT * FROM agent_action_steps WHERE batch_id=? ORDER BY ordinal').all(row.id).map((step) => ({
      ...plan.steps[step.ordinal - 1]!, status: step.status, attemptCount: step.attempt_count,
      lastSafeOutcome: step.last_safe_outcome_json === null ? null : JSON.parse(step.last_safe_outcome_json),
      terminalLogId: step.terminal_log_id, startedAt: step.started_at_ms === null ? null : instant(step.started_at_ms),
      completedAt: step.completed_at_ms === null ? null : instant(step.completed_at_ms)
    }));
    const approval = row.approved_plan_digest_sha256 === null ? null : {
      approvedByPrincipalId: row.approved_by_principal_id!,
      planDigestSha256: row.approved_plan_digest_sha256,
      approvedAt: instant(row.approved_at_ms!),
      approvalExpiresAt: instant(row.approval_expires_at_ms!),
      approvalPolicy: { key: row.approval_policy_key!, version: row.approval_policy_version! },
      approvedBounds: JSON.parse(row.approved_bounds_json!)
    };
    return agentActionBatchViewSchema.parse({
      plan, planDigestSha256: row.plan_digest_sha256, status: row.status, version: row.version,
      currentOrdinal: row.current_ordinal, approval, pauseRequested: row.pause_requested === 1,
      cancelRequested: row.cancel_requested === 1,
      safeStatusDetail: row.safe_status_detail_json === null ? null : JSON.parse(row.safe_status_detail_json),
      createdAt: instant(row.created_at_ms), updatedAt: instant(row.updated_at_ms), steps
    });
  }
}

export function installAgentActionRunSchema(sqlite: Database): void {
  sqlite.exec('PRAGMA foreign_keys=ON;');
  sqlite.exec(AGENT_ACTION_RUN_SQL);
}
