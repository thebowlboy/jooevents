import {
  effectfulOperationResultSchema,
  versionedDefinitionRefSchema,
  type EffectfulOperationResult,
  type VersionedDefinitionRef
} from '@jooevents/contracts';
import {
  recheckEffectInvocationCurrentAuthorityInTransaction,
  isSealedOperationAuditRecord,
  type EffectAuthorityRecheckSource,
  type DirectAuditedUnitOfWork,
  type DirectOperationLogRecord,
  type SealedEffectAuthorityRecheckResult,
  type ShortOperationAuditRecord,
  type TerminalNewOperationAuditRecord,
  EffectHandlerSnapshot,
  EffectInvocationContext,
  EffectOperationIdentity,
  EffectUnitOfWork,
  EffectUnitOfWorkPort,
  TerminalEffectReceipt
} from '@jooevents/application';
import { canonicalJsonText } from '@jooevents/kernel';
import { Database } from 'bun:sqlite';
import { loadSQLiteFoundationArtifacts } from './migration-runner';

/**
 * This schema contributes to the accepted epoch-2 baseline and may also be used to
 * prove the ordinary-write transaction in isolated SQLite fixtures.
 */
export const FOUNDATION_TRIAL_UOW_SQL = `
CREATE TABLE operation_log (
  id TEXT PRIMARY KEY CHECK(
    length(id) = 36
    AND id NOT GLOB '*[^0-9a-f-]*'
  ),
  operation_name TEXT NOT NULL CHECK(length(operation_name) BETWEEN 1 AND 160),
  operation_version INTEGER NOT NULL CHECK(operation_version > 0),
  registry_digest_sha256 TEXT NOT NULL CHECK(length(registry_digest_sha256) = 64 AND registry_digest_sha256 NOT GLOB '*[^0-9a-f]*'),
  surface TEXT NOT NULL CHECK(surface IN ('operator_http', 'participant_http', 'public_http', 'external_mcp', 'app_model', 'application_job', 'provider_ingress')),
  actor_json TEXT NOT NULL CHECK(
    length(actor_json) BETWEEN 2 AND 4096
    AND json_valid(actor_json)
    AND json_type(actor_json) = 'object'
  ),
  authority_principal_key TEXT NOT NULL CHECK(length(authority_principal_key) BETWEEN 1 AND 256),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) = 36),
  event_id TEXT CHECK(event_id IS NULL OR length(event_id) = 36),
  subjects_json TEXT NOT NULL CHECK(
    length(subjects_json) BETWEEN 2 AND 4096
    AND
    json_valid(subjects_json)
    AND json_type(subjects_json) = 'array'
    AND json_array_length(subjects_json) BETWEEN 1 AND 16
  ),
  summary TEXT NOT NULL CHECK(length(summary) BETWEEN 1 AND 240),
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms >= 0),
  correlation_id TEXT NOT NULL CHECK(
    length(correlation_id) = 36
    AND correlation_id NOT GLOB '*[^0-9a-f-]*'
  ),
  scope_partition_key TEXT NOT NULL CHECK(length(scope_partition_key) = 64 AND scope_partition_key NOT GLOB '*[^0-9a-f]*'),
  idempotency_verifier_profile_key TEXT NOT NULL CHECK(length(idempotency_verifier_profile_key) BETWEEN 1 AND 160),
  idempotency_verifier_profile_version INTEGER NOT NULL CHECK(idempotency_verifier_profile_version > 0),
  idempotency_key_verifier TEXT NOT NULL CHECK(length(idempotency_key_verifier) = 64 AND idempotency_key_verifier NOT GLOB '*[^0-9a-f]*'),
  request_hash TEXT NOT NULL CHECK(length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  result_json TEXT NOT NULL CHECK(
    length(result_json) BETWEEN 2 AND 65536
    AND json_valid(result_json)
    AND json_extract(result_json, '$.receipt.id') = id
    AND json_extract(result_json, '$.receipt.operationName') = operation_name
    AND json_extract(result_json, '$.receipt.operationVersion') = operation_version
    AND (
      json_extract(result_json, '$.kind') = 'success'
      OR (
        json_extract(result_json, '$.kind') = 'outcome'
        AND json_extract(result_json, '$.terminal') = 1
      )
    )
  ),
  action_batch_id TEXT,
  action_step_id TEXT,
  CHECK((action_batch_id IS NULL) = (action_step_id IS NULL)),
  UNIQUE (
    scope_partition_key,
    authority_principal_key,
    operation_name,
    operation_version,
    surface,
    idempotency_verifier_profile_key,
    idempotency_verifier_profile_version,
    idempotency_key_verifier
  )
);

CREATE INDEX operation_log_workspace_history
  ON operation_log(workspace_id, occurred_at_ms DESC, id DESC);
CREATE INDEX operation_log_event_history
  ON operation_log(workspace_id, event_id, occurred_at_ms DESC, id DESC)
  WHERE event_id IS NOT NULL;
CREATE INDEX operation_log_actor_history
  ON operation_log(authority_principal_key, occurred_at_ms DESC, id DESC);

CREATE TRIGGER operation_log_no_update
BEFORE UPDATE ON operation_log
BEGIN
  SELECT RAISE(ABORT, 'operation log is immutable');
END;

CREATE TRIGGER operation_log_no_delete
BEFORE DELETE ON operation_log
BEGIN
  SELECT RAISE(ABORT, 'operation log is immutable');
END;
`;

export interface SQLiteEffectDomainAdapter {
  openHandlerSnapshot(
    capability: VersionedDefinitionRef,
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot;
  applyDomainContribution(contribution: unknown): void | Promise<void>;
  afterOperationLogInserted?(receipt: TerminalEffectReceipt): void | Promise<void>;
  afterEffectContributionInserted?(receiptId: string, contribution: unknown): void | Promise<void>;
  afterEffectApplicationCommitted?(identity: EffectOperationIdentity): void | Promise<void>;
  afterUnitOfWorkCommitted?(): void | Promise<void>;
  /** Runs exactly once after the transaction has either committed or rolled back. */
  afterUnitOfWorkFinished?(outcome: {
    readonly committed: boolean;
  }): void | Promise<void>;
}

export type SQLiteTrialEffectDomainAdapter = SQLiteEffectDomainAdapter;

export interface SQLiteEffectDomainAdapterRegistration {
  readonly capability: VersionedDefinitionRef;
  readonly adapter: SQLiteEffectDomainAdapter;
}

export interface SQLiteEffectDomainAdapterRegistry {
  readonly capabilities: readonly VersionedDefinitionRef[];
}

const registeredEffectDomains = new WeakMap<
  SQLiteEffectDomainAdapterRegistry,
  ReadonlyMap<string, SQLiteEffectDomainAdapter>
>();

function capabilityKey(capability: VersionedDefinitionRef): string {
  return `${capability.key}\u0000${capability.version}`;
}

function bindDomainAdapter(adapter: SQLiteEffectDomainAdapter): SQLiteEffectDomainAdapter {
  if (
    !adapter
    || typeof adapter !== 'object'
    || typeof adapter.openHandlerSnapshot !== 'function'
    || typeof adapter.applyDomainContribution !== 'function'
  ) {
    throw new TypeError('sqlite_effect_domain_adapter_invalid');
  }
  for (const hook of [
    'afterOperationLogInserted',
    'afterEffectContributionInserted',
    'afterEffectApplicationCommitted',
    'afterUnitOfWorkCommitted',
    'afterUnitOfWorkFinished'
  ] as const) {
    if (adapter[hook] !== undefined && typeof adapter[hook] !== 'function') {
      throw new TypeError(`sqlite_effect_domain_adapter_hook_invalid:${hook}`);
    }
  }
  return Object.freeze({
    openHandlerSnapshot: adapter.openHandlerSnapshot.bind(adapter),
    applyDomainContribution: adapter.applyDomainContribution.bind(adapter),
    ...(adapter.afterOperationLogInserted
      ? { afterOperationLogInserted: adapter.afterOperationLogInserted.bind(adapter) }
      : {}),
    ...(adapter.afterEffectContributionInserted
      ? { afterEffectContributionInserted: adapter.afterEffectContributionInserted.bind(adapter) }
      : {}),
    ...(adapter.afterEffectApplicationCommitted
      ? { afterEffectApplicationCommitted: adapter.afterEffectApplicationCommitted.bind(adapter) }
      : {}),
    ...(adapter.afterUnitOfWorkCommitted
      ? { afterUnitOfWorkCommitted: adapter.afterUnitOfWorkCommitted.bind(adapter) }
      : {}),
    ...(adapter.afterUnitOfWorkFinished
      ? { afterUnitOfWorkFinished: adapter.afterUnitOfWorkFinished.bind(adapter) }
      : {})
  });
}

export function createSQLiteEffectDomainAdapterRegistry(
  registrations: readonly SQLiteEffectDomainAdapterRegistration[]
): SQLiteEffectDomainAdapterRegistry {
  if (!Array.isArray(registrations)) {
    throw new TypeError('sqlite_effect_domain_adapter_registrations_invalid');
  }
  const byCapability = new Map<string, SQLiteEffectDomainAdapter>();
  const capabilities: VersionedDefinitionRef[] = [];
  for (const registration of registrations) {
    const parsed = versionedDefinitionRefSchema.safeParse(registration?.capability);
    if (!parsed.success) throw new TypeError('sqlite_effect_domain_capability_invalid');
    const capability = Object.freeze({ ...parsed.data });
    const key = capabilityKey(capability);
    if (byCapability.has(key)) {
      throw new TypeError(`sqlite_effect_domain_capability_duplicate:${capability.key}@${capability.version}`);
    }
    byCapability.set(key, bindDomainAdapter(registration.adapter));
    capabilities.push(capability);
  }
  capabilities.sort((left, right) => left.key.localeCompare(right.key) || left.version - right.version);
  const registry = Object.freeze({ capabilities: Object.freeze(capabilities) });
  registeredEffectDomains.set(registry, byCapability);
  return registry;
}

function resolveRegisteredEffectDomain(
  registry: SQLiteEffectDomainAdapterRegistry,
  candidate: VersionedDefinitionRef
): SQLiteEffectDomainAdapter {
  const registrations = registeredEffectDomains.get(registry);
  if (!registrations) throw new TypeError('sqlite_effect_domain_adapter_registry_unsealed');
  const parsed = versionedDefinitionRefSchema.safeParse(candidate);
  if (!parsed.success) throw new TypeError('sqlite_effect_domain_capability_invalid');
  const adapter = registrations.get(capabilityKey(parsed.data));
  if (!adapter) {
    throw new TypeError(`sqlite_effect_domain_capability_unregistered:${parsed.data.key}@${parsed.data.version}`);
  }
  return adapter;
}

export interface SQLiteEffectAuditHooks {
  afterShortAuditInserted?(record: ShortOperationAuditRecord): void | Promise<void>;
  afterShortAuditCommitted?(record: ShortOperationAuditRecord): void | Promise<void>;
}

export type SQLiteTrialEffectAuditHooks = SQLiteEffectAuditHooks;

interface ReceiptRow {
  readonly id: string;
  readonly scope_partition_key: string;
  readonly authority_principal_key: string;
  readonly operation_name: string;
  readonly operation_version: number;
  readonly surface: EffectOperationIdentity['surface'];
  readonly idempotency_verifier_profile_key: string;
  readonly idempotency_verifier_profile_version: number;
  readonly idempotency_key_verifier: string;
  readonly request_hash: string;
  readonly result_json: string;
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function identityValues(
  identity: EffectOperationIdentity
): readonly [string, string, string, number, string, string, number, string] {
  return [
    identity.scopePartitionKey,
    identity.authorityPrincipalKey,
    identity.operationName,
    identity.operationVersion,
    identity.surface,
    identity.idempotencyVerifierProfile.key,
    identity.idempotencyVerifierProfile.version,
    identity.idempotencyKeyVerifier
  ];
}

function identityInsertValues(
  identity: EffectOperationIdentity
): readonly [string, string, string, number, string, string, number, string] {
  return [
    identity.scopePartitionKey,
    identity.authorityPrincipalKey,
    identity.operationName,
    identity.operationVersion,
    identity.surface,
    identity.idempotencyVerifierProfile.key,
    identity.idempotencyVerifierProfile.version,
    identity.idempotencyKeyVerifier
  ];
}

function receiptFromRow(row: ReceiptRow): TerminalEffectReceipt {
  const result = effectfulOperationResultSchema.parse(JSON.parse(row.result_json)) as EffectfulOperationResult;
  return deepFreeze({
    ref: {
      id: row.id,
      operationName: row.operation_name,
      operationVersion: row.operation_version
    },
    identity: {
      scopePartitionKey: row.scope_partition_key,
      authorityPrincipalKey: row.authority_principal_key,
      operationName: row.operation_name,
      operationVersion: row.operation_version,
      surface: row.surface,
      idempotencyVerifierProfile: {
        key: row.idempotency_verifier_profile_key,
        version: row.idempotency_verifier_profile_version
      },
      idempotencyKeyVerifier: row.idempotency_key_verifier
    },
    requestHash: row.request_hash,
    result
  });
}

export function installFoundationTrialUnitOfWorkSchema(sqlite: Database): void {
  sqlite.exec('PRAGMA foreign_keys = ON;');
  const identityInstalled = sqlite.query<{ readonly count: number }, []>(
    "SELECT count(*) AS count FROM sqlite_schema WHERE type='table' AND name='workspaces'"
  ).get()?.count === 1;
  if (!identityInstalled) sqlite.exec(loadSQLiteFoundationArtifacts().predecessor.sql);
  sqlite.exec(FOUNDATION_TRIAL_UOW_SQL);
}

class SQLiteEffectUnitOfWorkBase implements EffectUnitOfWorkPort {
  #active = false;
  readonly #authorityRecheck: EffectAuthorityRecheckSource;
  #agentActionStep: {
    readonly batchId: string;
    readonly stepId: string;
    readonly workerId: string;
    readonly leaseVersion: number;
    readonly leaseExpiresAtMs: number;
    readonly completedAtMs: number;
  } | undefined;

  constructor(
    private readonly sqlite: Database,
    private readonly resolveDomain: (capability: VersionedDefinitionRef) => SQLiteEffectDomainAdapter,
    authorityRecheck: EffectAuthorityRecheckSource,
    private readonly auditHooks: SQLiteEffectAuditHooks = {}
  ) {
    if (!authorityRecheck
      || typeof authorityRecheck.resolveAuthority !== 'function'
      || typeof authorityRecheck.now !== 'function') {
      throw new TypeError('foundation_transaction_authority_recheck_required');
    }
    const resolveAuthority = authorityRecheck.resolveAuthority.bind(authorityRecheck);
    const now = authorityRecheck.now.bind(authorityRecheck);
    this.#authorityRecheck = Object.freeze({ resolveAuthority, now });
  }

  async executeApprovedAgentActionStep<Value>(input: {
    readonly batchId: string;
    readonly stepId: string;
    readonly workerId: string;
    readonly leaseVersion: number;
    readonly leaseExpiresAt: string;
    readonly completedAt: string;
    readonly execute: () => Promise<Value>;
  }): Promise<Value> {
    if (this.#agentActionStep) throw new TypeError('agent_action_step_execution_nested');
    const leaseExpiresAtMs = Date.parse(input.leaseExpiresAt);
    const completedAtMs = Date.parse(input.completedAt);
    if (!Number.isSafeInteger(leaseExpiresAtMs) || !Number.isSafeInteger(completedAtMs)) {
      throw new TypeError('agent_action_step_execution_time_invalid');
    }
    this.#agentActionStep = Object.freeze({
      batchId: input.batchId,
      stepId: input.stepId,
      workerId: input.workerId,
      leaseVersion: input.leaseVersion,
      leaseExpiresAtMs,
      completedAtMs
    });
    try {
      return await input.execute();
    } finally {
      this.#agentActionStep = undefined;
    }
  }

  private completeApprovedAgentActionStep(operationLogId: string): void {
    const action = this.#agentActionStep;
    if (!action) return;
    const lease = this.sqlite.query<{
      readonly lease_owner: string | null;
      readonly lease_version: number;
      readonly lease_expires_at_ms: number | null;
    }, [string]>('SELECT lease_owner,lease_version,lease_expires_at_ms FROM agent_action_batches WHERE id=?')
      .get(action.batchId);
    if (!lease || lease.lease_owner !== action.workerId
      || lease.lease_version !== action.leaseVersion
      || lease.lease_expires_at_ms !== action.leaseExpiresAtMs) {
      throw new TypeError('agent_action_lease_lost');
    }
    const changed = this.sqlite.query(`UPDATE agent_action_steps SET status='succeeded',terminal_log_id=?,
      last_safe_outcome_json=NULL,completed_at_ms=?,updated_at_ms=?
      WHERE batch_id=? AND id=? AND status='running'`)
      .run(operationLogId, action.completedAtMs, action.completedAtMs, action.batchId, action.stepId);
    if (changed.changes !== 1) throw new TypeError('agent_action_step_success_stale');
  }

  findTerminalReceipt(identity: EffectOperationIdentity): TerminalEffectReceipt | undefined {
    return this.findTerminalOperationLog(identity);
  }

  findTerminalOperationLog(identity: EffectOperationIdentity): TerminalEffectReceipt | undefined {
    const row = this.sqlite.query<ReceiptRow, [string, string, string, number, string, string, number, string]>(`
      SELECT id, scope_partition_key, authority_principal_key, operation_name,
             operation_version, surface, idempotency_verifier_profile_key,
             idempotency_verifier_profile_version, idempotency_key_verifier, request_hash,
             result_json
        FROM operation_log
       WHERE scope_partition_key = ?
         AND authority_principal_key = ?
         AND operation_name = ?
         AND operation_version = ?
         AND surface = ?
         AND idempotency_verifier_profile_key = ?
         AND idempotency_verifier_profile_version = ?
         AND idempotency_key_verifier = ?
    `).get(...identityValues(identity));
    return row ? receiptFromRow(row) : undefined;
  }

  async recordShortOperationAudit(record: ShortOperationAuditRecord): Promise<void> {
    if (!isSealedOperationAuditRecord(record)) {
      throw new TypeError('unsealed_foundation_short_operation_audit');
    }
    await this.auditHooks.afterShortAuditInserted?.(record);
    await this.auditHooks.afterShortAuditCommitted?.(record);
  }

  async runInUnitOfWork<Value>(work: (unitOfWork: EffectUnitOfWork) => Promise<Value>): Promise<Value> {
    if (this.#active) throw new TypeError('nested_foundation_unit_of_work');
    this.#active = true;
    let beganOwnTransaction = false;
    let committed = false;
    let selectedDomain: {
      readonly capability: VersionedDefinitionRef;
      readonly adapter: SQLiteEffectDomainAdapter;
    } | undefined;
    const selectDomain = (candidate: VersionedDefinitionRef): SQLiteEffectDomainAdapter => {
      const parsed = versionedDefinitionRefSchema.safeParse(candidate);
      if (!parsed.success) throw new TypeError('sqlite_effect_domain_capability_invalid');
      if (selectedDomain) {
        if (capabilityKey(selectedDomain.capability) !== capabilityKey(parsed.data)) {
          throw new TypeError('sqlite_effect_domain_capability_changed_in_unit_of_work');
        }
        return selectedDomain.adapter;
      }
      const capability = Object.freeze({ ...parsed.data });
      const adapter = this.resolveDomain(capability);
      selectedDomain = Object.freeze({ capability, adapter });
      return adapter;
    };
    const unitOfWork: EffectUnitOfWork = Object.freeze({
      recheckCurrentAuthority: (context: EffectInvocationContext) => {
        if (!this.sqlite.inTransaction) {
          throw new TypeError('foundation_authority_recheck_requires_transaction');
        }
        return recheckEffectInvocationCurrentAuthorityInTransaction(context, this.#authorityRecheck);
      },
      findTerminalReceipt: (identity: EffectOperationIdentity) => this.findTerminalReceipt(identity),
      openHandlerSnapshot: (
        capability: VersionedDefinitionRef,
        context: EffectInvocationContext,
        authorityRecheck: SealedEffectAuthorityRecheckResult
      ) => selectDomain(capability).openHandlerSnapshot(capability, context, authorityRecheck),
      applyDomainContribution: (capability: VersionedDefinitionRef, contribution: unknown) =>
        selectDomain(capability).applyDomainContribution(contribution),
      insertOperationLog: (record: DirectOperationLogRecord) => {
        const identity = record.receipt.identity;
        const occurredAtMs = Date.parse(record.occurredAt);
        if (!Number.isSafeInteger(occurredAtMs) || occurredAtMs < 0) {
          throw new TypeError('operation_log_occurred_at_invalid');
        }
        this.sqlite.query<never, [
          string, string, number, string, string, string, string, string, string | null,
          string, string, number, string, string, string, number, string, string, string,
          string | null, string | null
        ]>(`
          INSERT INTO operation_log (
            id, operation_name, operation_version, registry_digest_sha256, surface,
            actor_json, authority_principal_key, workspace_id, event_id, subjects_json,
            summary, occurred_at_ms, correlation_id, scope_partition_key,
            idempotency_verifier_profile_key, idempotency_verifier_profile_version,
            idempotency_key_verifier, request_hash, result_json, action_batch_id,
            action_step_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          record.receipt.ref.id,
          identity.operationName,
          identity.operationVersion,
          record.registryDigestSha256,
          identity.surface,
          canonicalJsonText(record.actor),
          identity.authorityPrincipalKey,
          record.scope.workspaceId,
          record.scope.eventId ?? null,
          canonicalJsonText(record.scope.subjects),
          record.summary,
          occurredAtMs,
          record.correlationId,
          identity.scopePartitionKey,
          identity.idempotencyVerifierProfile.key,
          identity.idempotencyVerifierProfile.version,
          identity.idempotencyKeyVerifier,
          record.receipt.requestHash,
          canonicalJsonText(record.receipt.result),
          this.#agentActionStep?.batchId ?? record.actionBatchId ?? null,
          this.#agentActionStep?.stepId ?? record.actionStepId ?? null
        );
        this.completeApprovedAgentActionStep(record.receipt.ref.id);
        return selectedDomain?.adapter.afterOperationLogInserted?.(record.receipt);
      },
      applyEffectContribution: (receiptId: string, contribution: unknown) =>
        selectedDomain?.adapter.afterEffectContributionInserted?.(receiptId, contribution),
      finishEffectApplication: (identity: EffectOperationIdentity) =>
        selectedDomain?.adapter.afterEffectApplicationCommitted?.(identity)
    });

    try {
      this.sqlite.exec('BEGIN IMMEDIATE;');
      beganOwnTransaction = true;
      const result = await work(unitOfWork);
      this.sqlite.exec('COMMIT;');
      committed = true;
      await selectedDomain?.adapter.afterUnitOfWorkCommitted?.();
      return result;
    } catch (error) {
      if (beganOwnTransaction && this.sqlite.inTransaction) this.sqlite.exec('ROLLBACK;');
      throw error;
    } finally {
      try {
        await selectedDomain?.adapter.afterUnitOfWorkFinished?.({ committed });
      } finally {
        this.#active = false;
      }
    }
  }

  async runInDirectUnitOfWork<Value>(
    work: (unitOfWork: DirectAuditedUnitOfWork) => Promise<Value>
  ): Promise<Value> {
    if (this.#active) throw new TypeError('nested_foundation_direct_unit_of_work');
    this.#active = true;
    let beganOwnTransaction = false;
    let committed = false;
    let selectedDomain: {
      readonly capability: VersionedDefinitionRef;
      readonly adapter: SQLiteEffectDomainAdapter;
    } | undefined;
    const selectDomain = (candidate: VersionedDefinitionRef): SQLiteEffectDomainAdapter => {
      const parsed = versionedDefinitionRefSchema.safeParse(candidate);
      if (!parsed.success) throw new TypeError('sqlite_effect_domain_capability_invalid');
      if (selectedDomain) {
        if (capabilityKey(selectedDomain.capability) !== capabilityKey(parsed.data)) {
          throw new TypeError('sqlite_effect_domain_capability_changed_in_unit_of_work');
        }
        return selectedDomain.adapter;
      }
      const capability = Object.freeze({ ...parsed.data });
      const adapter = this.resolveDomain(capability);
      selectedDomain = Object.freeze({ capability, adapter });
      return adapter;
    };
    const unitOfWork: DirectAuditedUnitOfWork = Object.freeze({
      recheckCurrentAuthority: (context: EffectInvocationContext) => {
        if (!this.sqlite.inTransaction) {
          throw new TypeError('foundation_authority_recheck_requires_transaction');
        }
        return recheckEffectInvocationCurrentAuthorityInTransaction(context, this.#authorityRecheck);
      },
      findTerminalOperationLog: (identity: EffectOperationIdentity) =>
        this.findTerminalOperationLog(identity),
      openHandlerSnapshot: (
        capability: VersionedDefinitionRef,
        context: EffectInvocationContext,
        authorityRecheck: SealedEffectAuthorityRecheckResult
      ) => selectDomain(capability).openHandlerSnapshot(capability, context, authorityRecheck),
      applyDomainContribution: (capability: VersionedDefinitionRef, contribution: unknown) =>
        selectDomain(capability).applyDomainContribution(contribution),
      insertOperationLog: (record: DirectOperationLogRecord) => {
        const identity = record.receipt.identity;
        const occurredAtMs = Date.parse(record.occurredAt);
        if (!Number.isSafeInteger(occurredAtMs) || occurredAtMs < 0) {
          throw new TypeError('operation_log_occurred_at_invalid');
        }
        this.sqlite.query<never, [
          string, string, number, string, string, string, string, string, string | null,
          string, string, number, string, string, string, number, string, string, string,
          string | null, string | null
        ]>(`
          INSERT INTO operation_log (
            id, operation_name, operation_version, registry_digest_sha256, surface,
            actor_json, authority_principal_key, workspace_id, event_id, subjects_json,
            summary, occurred_at_ms, correlation_id, scope_partition_key,
            idempotency_verifier_profile_key, idempotency_verifier_profile_version,
            idempotency_key_verifier, request_hash, result_json, action_batch_id,
            action_step_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          record.receipt.ref.id,
          identity.operationName,
          identity.operationVersion,
          record.registryDigestSha256,
          identity.surface,
          canonicalJsonText(record.actor),
          identity.authorityPrincipalKey,
          record.scope.workspaceId,
          record.scope.eventId ?? null,
          canonicalJsonText(record.scope.subjects),
          record.summary,
          occurredAtMs,
          record.correlationId,
          identity.scopePartitionKey,
          identity.idempotencyVerifierProfile.key,
          identity.idempotencyVerifierProfile.version,
          identity.idempotencyKeyVerifier,
          record.receipt.requestHash,
          canonicalJsonText(record.receipt.result),
          this.#agentActionStep?.batchId ?? record.actionBatchId ?? null,
          this.#agentActionStep?.stepId ?? record.actionStepId ?? null
        );
        this.completeApprovedAgentActionStep(record.receipt.ref.id);
      }
    });

    try {
      this.sqlite.exec('BEGIN IMMEDIATE;');
      beganOwnTransaction = true;
      const result = await work(unitOfWork);
      this.sqlite.exec('COMMIT;');
      committed = true;
      await selectedDomain?.adapter.afterUnitOfWorkCommitted?.();
      return result;
    } catch (error) {
      if (beganOwnTransaction && this.sqlite.inTransaction) this.sqlite.exec('ROLLBACK;');
      throw error;
    } finally {
      try {
        await selectedDomain?.adapter.afterUnitOfWorkFinished?.({ committed });
      } finally {
        this.#active = false;
      }
    }
  }
}

export class SQLiteEffectUnitOfWorkPort extends SQLiteEffectUnitOfWorkBase {
  constructor(
    sqlite: Database,
    registry: SQLiteEffectDomainAdapterRegistry,
    authorityRecheck: EffectAuthorityRecheckSource,
    auditHooks: SQLiteEffectAuditHooks = {}
  ) {
    if (!registeredEffectDomains.has(registry)) {
      throw new TypeError('sqlite_effect_domain_adapter_registry_unsealed');
    }
    super(
      sqlite,
      (capability) => resolveRegisteredEffectDomain(registry, capability),
      authorityRecheck,
      auditHooks
    );
  }

}

export class SQLiteTrialEffectUnitOfWorkPort extends SQLiteEffectUnitOfWorkBase {
  constructor(
    sqlite: Database,
    domain: SQLiteTrialEffectDomainAdapter,
    authorityRecheck: EffectAuthorityRecheckSource,
    auditHooks: SQLiteTrialEffectAuditHooks = {}
  ) {
    const boundDomain = bindDomainAdapter(domain);
    super(sqlite, () => boundDomain, authorityRecheck, auditHooks);
  }
}
