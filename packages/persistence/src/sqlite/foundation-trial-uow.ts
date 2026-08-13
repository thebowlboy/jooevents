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

/**
 * Disposable F1 schema used to prove the ordinary-write transaction against real
 * SQLite. It is intentionally not part of the retained migration manifest.
 */
export const FOUNDATION_TRIAL_UOW_SQL = `
CREATE TABLE foundation_trial_operation_execution_claims (
  scope_partition_key TEXT NOT NULL CHECK(length(scope_partition_key) = 64 AND scope_partition_key NOT GLOB '*[^0-9a-f]*'),
  authority_principal_key TEXT NOT NULL CHECK(length(authority_principal_key) BETWEEN 1 AND 256),
  operation_name TEXT NOT NULL CHECK(length(operation_name) BETWEEN 1 AND 160),
  operation_version INTEGER NOT NULL CHECK(operation_version > 0),
  surface TEXT NOT NULL CHECK(surface IN ('operator_http', 'participant_http', 'public_http', 'external_mcp', 'app_model', 'application_job', 'provider_ingress')),
  idempotency_verifier_profile_key TEXT NOT NULL CHECK(length(idempotency_verifier_profile_key) BETWEEN 1 AND 160),
  idempotency_verifier_profile_version INTEGER NOT NULL CHECK(idempotency_verifier_profile_version > 0),
  idempotency_key_verifier TEXT NOT NULL CHECK(length(idempotency_key_verifier) = 64 AND idempotency_key_verifier NOT GLOB '*[^0-9a-f]*'),
  request_hash TEXT NOT NULL CHECK(length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY (
    scope_partition_key,
    authority_principal_key,
    operation_name,
    operation_version,
    surface,
    idempotency_verifier_profile_key,
    idempotency_verifier_profile_version,
    idempotency_key_verifier
  )
) WITHOUT ROWID;

CREATE TABLE foundation_trial_operation_receipts (
  id TEXT PRIMARY KEY,
  scope_partition_key TEXT NOT NULL CHECK(length(scope_partition_key) = 64 AND scope_partition_key NOT GLOB '*[^0-9a-f]*'),
  authority_principal_key TEXT NOT NULL CHECK(length(authority_principal_key) BETWEEN 1 AND 256),
  operation_name TEXT NOT NULL CHECK(length(operation_name) BETWEEN 1 AND 160),
  operation_version INTEGER NOT NULL CHECK(operation_version > 0),
  surface TEXT NOT NULL CHECK(surface IN ('operator_http', 'participant_http', 'public_http', 'external_mcp', 'app_model', 'application_job', 'provider_ingress')),
  idempotency_verifier_profile_key TEXT NOT NULL CHECK(length(idempotency_verifier_profile_key) BETWEEN 1 AND 160),
  idempotency_verifier_profile_version INTEGER NOT NULL CHECK(idempotency_verifier_profile_version > 0),
  idempotency_key_verifier TEXT NOT NULL CHECK(length(idempotency_key_verifier) = 64 AND idempotency_key_verifier NOT GLOB '*[^0-9a-f]*'),
  request_hash TEXT NOT NULL CHECK(length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  result_json TEXT NOT NULL CHECK(
    json_valid(result_json)
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

CREATE TRIGGER foundation_trial_operation_receipts_no_update
BEFORE UPDATE ON foundation_trial_operation_receipts
BEGIN
  SELECT RAISE(ABORT, 'foundation operation receipts are immutable');
END;

CREATE TRIGGER foundation_trial_operation_receipts_no_delete
BEFORE DELETE ON foundation_trial_operation_receipts
BEGIN
  SELECT RAISE(ABORT, 'foundation operation receipts are immutable');
END;

CREATE TABLE foundation_trial_operation_receipt_children (
  receipt_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  contribution_json TEXT NOT NULL CHECK(json_valid(contribution_json)),
  PRIMARY KEY (receipt_id, ordinal),
  FOREIGN KEY (receipt_id) REFERENCES foundation_trial_operation_receipts(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TRIGGER foundation_trial_operation_receipt_children_no_update
BEFORE UPDATE ON foundation_trial_operation_receipt_children
BEGIN
  SELECT RAISE(ABORT, 'foundation operation receipt children are immutable');
END;

CREATE TRIGGER foundation_trial_operation_receipt_children_no_delete
BEFORE DELETE ON foundation_trial_operation_receipt_children
BEGIN
  SELECT RAISE(ABORT, 'foundation operation receipt children are immutable');
END;

CREATE TABLE foundation_trial_operation_audits (
  event_id TEXT PRIMARY KEY CHECK(length(event_id) = 36),
  disposition TEXT NOT NULL CHECK(disposition IN (
    'terminal_new', 'terminal_replay', 'context_denied', 'idempotency_conflict',
    'nonterminal_progress'
  )),
  receipt_id TEXT,
  related_receipt_id TEXT,
  record_json TEXT NOT NULL CHECK(
    json_valid(record_json)
    AND json_extract(record_json, '$.eventId') = event_id
    AND json_extract(record_json, '$.disposition') = disposition
    AND (
      (
        disposition = 'terminal_new'
        AND receipt_id IS NOT NULL
        AND related_receipt_id IS NULL
        AND json_extract(record_json, '$.receiptId') = receipt_id
        AND json_type(record_json, '$.relatedReceiptId') IS NULL
      )
      OR (
        disposition = 'terminal_replay'
        AND receipt_id IS NULL
        AND related_receipt_id IS NOT NULL
        AND json_type(record_json, '$.receiptId') IS NULL
        AND json_extract(record_json, '$.relatedReceiptId') = related_receipt_id
      )
      OR (
        disposition IN ('context_denied', 'idempotency_conflict', 'nonterminal_progress')
        AND receipt_id IS NULL
        AND related_receipt_id IS NULL
        AND json_type(record_json, '$.receiptId') IS NULL
        AND json_type(record_json, '$.relatedReceiptId') IS NULL
      )
    )
  ),
  FOREIGN KEY (receipt_id) REFERENCES foundation_trial_operation_receipts(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (related_receipt_id) REFERENCES foundation_trial_operation_receipts(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE UNIQUE INDEX foundation_trial_operation_audits_terminal_receipt
  ON foundation_trial_operation_audits(receipt_id)
  WHERE disposition = 'terminal_new';

CREATE TRIGGER foundation_trial_operation_audits_no_update
BEFORE UPDATE ON foundation_trial_operation_audits
BEGIN
  SELECT RAISE(ABORT, 'foundation operation audits are immutable');
END;

CREATE TRIGGER foundation_trial_operation_audits_no_delete
BEFORE DELETE ON foundation_trial_operation_audits
BEGIN
  SELECT RAISE(ABORT, 'foundation operation audits are immutable');
END;
`;

export interface SQLiteEffectDomainAdapter {
  openHandlerSnapshot(
    capability: VersionedDefinitionRef,
    context: EffectInvocationContext,
    authorityRecheck: SealedEffectAuthorityRecheckResult
  ): EffectHandlerSnapshot;
  applyDomainContribution(contribution: unknown): void | Promise<void>;
  afterReceiptParentInserted?(receipt: TerminalEffectReceipt): void | Promise<void>;
  afterReceiptChildInserted?(receiptId: string, contribution: unknown): void | Promise<void>;
  afterExecutionClaimReleased?(identity: EffectOperationIdentity): void | Promise<void>;
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
    'afterReceiptParentInserted',
    'afterReceiptChildInserted',
    'afterExecutionClaimReleased',
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
    ...(adapter.afterReceiptParentInserted
      ? { afterReceiptParentInserted: adapter.afterReceiptParentInserted.bind(adapter) }
      : {}),
    ...(adapter.afterReceiptChildInserted
      ? { afterReceiptChildInserted: adapter.afterReceiptChildInserted.bind(adapter) }
      : {}),
    ...(adapter.afterExecutionClaimReleased
      ? { afterExecutionClaimReleased: adapter.afterExecutionClaimReleased.bind(adapter) }
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
  afterTerminalAuditInserted?(record: TerminalNewOperationAuditRecord): void | Promise<void>;
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
  sqlite.exec(FOUNDATION_TRIAL_UOW_SQL);
}

class SQLiteEffectUnitOfWorkBase implements EffectUnitOfWorkPort {
  #active = false;
  readonly #authorityRecheck: EffectAuthorityRecheckSource;

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

  findTerminalReceipt(identity: EffectOperationIdentity): TerminalEffectReceipt | undefined {
    const row = this.sqlite.query<ReceiptRow, [string, string, string, number, string, string, number, string]>(`
      SELECT id, scope_partition_key, authority_principal_key, operation_name,
             operation_version, surface, idempotency_verifier_profile_key,
             idempotency_verifier_profile_version, idempotency_key_verifier, request_hash,
             result_json
        FROM foundation_trial_operation_receipts
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
    if (this.#active) throw new TypeError('nested_foundation_short_audit_unit_of_work');
    if (!isSealedOperationAuditRecord(record)) {
      throw new TypeError('unsealed_foundation_short_operation_audit');
    }
    const canonical = canonicalJsonText(record);
    let beganOwnTransaction = false;
    try {
      this.#active = true;
      this.sqlite.exec('BEGIN IMMEDIATE;');
      beganOwnTransaction = true;
      const relatedReceiptId = record.disposition === 'terminal_replay'
        ? record.relatedReceiptId
        : null;
      const inserted = this.sqlite.query<never, [string, string, null, string | null, string]>(`
        INSERT INTO foundation_trial_operation_audits (
          event_id, disposition, receipt_id, related_receipt_id, record_json
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(event_id) DO NOTHING
      `).run(record.eventId, record.disposition, null, relatedReceiptId, canonical);
      if (inserted.changes === 0) {
        const existing = this.sqlite.query<{ readonly record_json: string }, [string]>(`
          SELECT record_json FROM foundation_trial_operation_audits WHERE event_id = ?
        `).get(record.eventId);
        if (!existing || existing.record_json !== canonical) {
          throw new TypeError('operation_audit_identity_conflict');
        }
      } else {
        await this.auditHooks.afterShortAuditInserted?.(record);
      }
      this.sqlite.exec('COMMIT;');
      await this.auditHooks.afterShortAuditCommitted?.(record);
    } catch (error) {
      if (beganOwnTransaction && this.sqlite.inTransaction) this.sqlite.exec('ROLLBACK;');
      throw error;
    } finally {
      this.#active = false;
    }
  }

  async runInUnitOfWork<Value>(work: (unitOfWork: EffectUnitOfWork) => Promise<Value>): Promise<Value> {
    if (this.#active) throw new TypeError('nested_foundation_unit_of_work');
    this.#active = true;
    let beganOwnTransaction = false;
    let committed = false;
    const childOrdinals = new Map<string, number>();
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
      acquireExecutionClaim: (identity: EffectOperationIdentity, requestHash: string) => {
        const result = this.sqlite.query<never, [string, string, string, number, string, string, number, string, string]>(`
          INSERT INTO foundation_trial_operation_execution_claims (
            scope_partition_key, authority_principal_key, operation_name,
            operation_version, surface, idempotency_verifier_profile_key,
            idempotency_verifier_profile_version, idempotency_key_verifier, request_hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT DO NOTHING
        `).run(...identityInsertValues(identity), requestHash);
        if (result.changes === 1) return { kind: 'acquired' as const };
        const existing = this.sqlite.query<{ readonly request_hash: string }, [string, string, string, number, string, string, number, string]>(`
          SELECT request_hash
            FROM foundation_trial_operation_execution_claims
           WHERE scope_partition_key = ?
             AND authority_principal_key = ?
             AND operation_name = ?
             AND operation_version = ?
             AND surface = ?
             AND idempotency_verifier_profile_key = ?
             AND idempotency_verifier_profile_version = ?
             AND idempotency_key_verifier = ?
        `).get(...identityValues(identity));
        if (!existing) throw new TypeError('foundation_execution_claim_disappeared');
        return existing.request_hash === requestHash
          ? { kind: 'contended_same_request' as const }
          : { kind: 'contended_changed_request' as const };
      },
      findTerminalReceipt: (identity: EffectOperationIdentity) => this.findTerminalReceipt(identity),
      openHandlerSnapshot: (
        capability: VersionedDefinitionRef,
        context: EffectInvocationContext,
        authorityRecheck: SealedEffectAuthorityRecheckResult
      ) => selectDomain(capability).openHandlerSnapshot(capability, context, authorityRecheck),
      applyDomainContribution: (capability: VersionedDefinitionRef, contribution: unknown) =>
        selectDomain(capability).applyDomainContribution(contribution),
      insertReceiptParent: (receipt: TerminalEffectReceipt) => {
        const identity = receipt.identity;
        this.sqlite.query<never, [string, string, string, string, number, string, string, number, string, string, string]>(`
          INSERT INTO foundation_trial_operation_receipts (
            id, scope_partition_key, authority_principal_key, operation_name,
            operation_version, surface, idempotency_verifier_profile_key,
            idempotency_verifier_profile_version, idempotency_key_verifier,
            request_hash, result_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          receipt.ref.id,
          ...identityInsertValues(identity),
          receipt.requestHash,
          canonicalJsonText(receipt.result)
        );
        return selectedDomain?.adapter.afterReceiptParentInserted?.(receipt);
      },
      insertTerminalNewOperationAudit: (record: TerminalNewOperationAuditRecord) => {
        if (!isSealedOperationAuditRecord(record) || record.disposition !== 'terminal_new') {
          throw new TypeError('unsealed_foundation_terminal_operation_audit');
        }
        this.sqlite.query<never, [string, string, string, null, string]>(`
          INSERT INTO foundation_trial_operation_audits (
            event_id, disposition, receipt_id, related_receipt_id, record_json
          ) VALUES (?, ?, ?, ?, ?)
        `).run(
          record.eventId,
          record.disposition,
          record.receiptId,
          null,
          canonicalJsonText(record)
        );
        return this.auditHooks.afterTerminalAuditInserted?.(record);
      },
      insertReceiptChild: (receiptId: string, contribution: unknown) => {
        const ordinal = childOrdinals.get(receiptId) ?? 0;
        this.sqlite.query<never, [string, number, string]>(`
          INSERT INTO foundation_trial_operation_receipt_children (
            receipt_id, ordinal, contribution_json
          ) VALUES (?, ?, ?)
        `).run(receiptId, ordinal, canonicalJsonText(contribution));
        childOrdinals.set(receiptId, ordinal + 1);
        return selectedDomain?.adapter.afterReceiptChildInserted?.(receiptId, contribution);
      },
      releaseExecutionClaim: (identity: EffectOperationIdentity) => {
        const result = this.sqlite.query<never, [string, string, string, number, string, string, number, string]>(`
          DELETE FROM foundation_trial_operation_execution_claims
           WHERE scope_partition_key = ?
             AND authority_principal_key = ?
             AND operation_name = ?
             AND operation_version = ?
             AND surface = ?
             AND idempotency_verifier_profile_key = ?
             AND idempotency_verifier_profile_version = ?
             AND idempotency_key_verifier = ?
        `).run(...identityInsertValues(identity));
        if (result.changes !== 1) throw new TypeError('missing_foundation_execution_claim');
        return selectedDomain?.adapter.afterExecutionClaimReleased?.(identity);
      }
    });

    try {
      this.sqlite.exec('BEGIN IMMEDIATE;');
      beganOwnTransaction = true;
      const result = await work(unitOfWork);
      const claimCount = this.sqlite.query<{ readonly count: number }, []>(
        'SELECT count(*) AS count FROM foundation_trial_operation_execution_claims'
      ).get()?.count ?? -1;
      if (claimCount !== 0) throw new TypeError('foundation_execution_claim_not_released');
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
